import CoreBluetooth
import Foundation

/// The local GATT server of the peripheral role (plan §4.4, §5.5, P4-01).
///
/// iOS answers static values and keeps subscriptions itself. Reads and writes of dynamic
/// characteristics go to JS (`GattServerListener`) and must be answered within
/// `responseDeadline`, or the core answers with an ATT error. Long reads come from the
/// `ServerReadCache`; a long write (prepared writes, delivered by iOS as one request array) reaches
/// JS as one write per characteristic.
///
/// Threading (plan §4.7): everything on the peripheral queue (`scheduler`).
final class GattServer {
  /// JS must answer before this. ATT gives a request 30 s (Core spec Vol 3 Part F 3.3.3).
  static let responseDeadline: TimeInterval = 25
  static let addServiceTimeout: TimeInterval = 10
  static let maxValueLength = 512

  weak var listener: GattServerListener?

  let readCache: ServerReadCache
  private let services: [ServerServiceSpec]
  private let characteristics: [CBUUID: ServerCharacteristicSpec]
  private let manager: PeripheralManaging
  private let scheduler: Scheduling
  private var nextRequestId = 1
  private var pending: [Int: Pending] = [:]
  private var adding: AddingServices?
  private var subscribers: [CBUUID: Set<UUID>] = [:]
  /// An open waiting for a new manager to leave `.unknown`.
  private var waiting: (completion: (CoreError?) -> Void, timeout: CancellableWork)?

  /// The services still to publish, and the open waiting for them.
  private struct AddingServices {
    let completion: (CoreError?) -> Void
    let remaining: [ServerServiceSpec]
    let timeout: CancellableWork
  }

  /// A JS request waiting for its answer; the writes of one request array share an `ExecuteGroup`.
  private final class Pending {
    let isRead: Bool
    let request: ATTRequestLike
    let characteristic: CBUUID
    let group: ExecuteGroup?
    var deadline: CancellableWork?

    init(isRead: Bool, request: ATTRequestLike, characteristic: CBUUID, group: ExecuteGroup?) {
      self.isRead = isRead
      self.request = request
      self.characteristic = characteristic
      self.group = group
    }
  }

  private final class ExecuteGroup {
    let first: ATTRequestLike
    var remaining: Int
    var result: CBATTError.Code = .success

    init(first: ATTRequestLike, remaining: Int) {
      self.first = first
      self.remaining = remaining
    }
  }

  init(services: [ServerServiceSpec], manager: PeripheralManaging, scheduler: Scheduling) {
    self.services = services
    self.manager = manager
    self.scheduler = scheduler
    characteristics = Dictionary(
      services.flatMap { $0.characteristics }.map { ($0.uuid, $0) },
      uniquingKeysWith: { first, _ in first }
    )
    readCache = ServerReadCache(now: { [scheduler] in scheduler.now })
  }

  /// Publishes the services one at a time, once the manager is powered on.
  func open(_ completion: @escaping (CoreError?) -> Void) {
    manager.delegate = self
    guard manager.state == .unknown || manager.state == .resetting else { return start(completion) }
    let timeout = scheduler.schedule(after: Self.addServiceTimeout) { [weak self] in
      self?.waiting = nil
      completion(CoreError(.bluetoothResetting, "Bluetooth didn't become ready for the GATT server"))
    }
    waiting = (completion, timeout)
  }

  private func start(_ completion: @escaping (CoreError?) -> Void) {
    switch manager.state {
    case .poweredOn:
      addNext(services, completion)
    case .unauthorized:
      completion(CoreError(.bluetoothUnauthorized, "The app may not use Bluetooth"))
    case .unsupported:
      completion(CoreError(.bluetoothUnsupported, "This device can't act as a Bluetooth LE peripheral"))
    default:
      completion(CoreError(.bluetoothPoweredOff, "Bluetooth is off"))
    }
  }

  /// JS answers a read: the whole value, or an ATT error. Unknown or expired requests are ignored.
  func respondToRead(requestId: Int, value: Data?, attError: Int?) {
    guard let request = pending.removeValue(forKey: requestId) else { return }
    request.deadline?.cancel()
    guard let value, attError == nil else {
      manager.respond(to: request.request, withResult: Self.code(attError))
      return
    }
    readCache.store(central: request.request.centralId, characteristic: request.characteristic, value: value)
    answerRead(request.request, value: value)
  }

  /// JS answers a write: nil for success, or an ATT error.
  func respondToWrite(requestId: Int, attError: Int?) {
    guard let request = pending.removeValue(forKey: requestId), let group = request.group else { return }
    request.deadline?.cancel()
    let result = attError.map { Self.code($0) } ?? .success
    if result != .success && group.result == .success { group.result = result }
    group.remaining -= 1
    if group.remaining == 0 { manager.respond(to: group.first, withResult: group.result) }
  }

  func close() {
    waiting?.timeout.cancel()
    waiting = nil
    pending.values.forEach { $0.deadline?.cancel() }
    pending.removeAll()
    adding?.timeout.cancel()
    adding = nil
    subscribers.removeAll()
    readCache.clear()
    manager.removeAllServices()
    manager.delegate = nil
  }

  /// Centrals subscribed to `characteristic`, for P4-02's notifications.
  func subscribedCentrals(_ characteristic: CBUUID) -> Set<UUID> {
    subscribers[characteristic] ?? []
  }

  private func addNext(_ remaining: [ServerServiceSpec], _ completion: @escaping (CoreError?) -> Void) {
    guard let service = remaining.first else { return completion(nil) }
    let timeout = scheduler.schedule(after: Self.addServiceTimeout) { [weak self] in
      self?.adding = nil
      self?.close()
      completion(CoreError(.operationTimeout, "Adding service \(service.uuid.uuidString) timed out"))
    }
    adding = AddingServices(completion: completion, remaining: remaining, timeout: timeout)
    manager.add(service)
  }

  private func answerRead(_ request: ATTRequestLike, value: Data) {
    guard let slice = ServerReadCache.slice(value, from: request.offset) else {
      return manager.respond(to: request, withResult: .invalidOffset)
    }
    request.value = slice
    manager.respond(to: request, withResult: .success)
  }

  private func ask(_ request: Pending, notify: (Int) -> Void) {
    let id = nextRequestId
    nextRequestId += 1
    pending[id] = request
    request.deadline = scheduler.schedule(after: Self.responseDeadline) { [weak self] in
      guard let self, self.pending[id] != nil else { return }
      let kind = request.isRead ? "read" : "write"
      self.listener?.gattServer(
        self,
        warning: CoreError(
          .operationTimeout,
          "The \(kind) request for \(request.characteristic.uuidString) wasn't answered within "
            + "\(Int(Self.responseDeadline)) s; the server answered with an ATT error"
        )
      )
      if request.isRead {
        self.respondToRead(requestId: id, value: nil, attError: Int(CBATTError.Code.unlikelyError.rawValue))
      } else {
        self.respondToWrite(requestId: id, attError: Int(CBATTError.Code.unlikelyError.rawValue))
      }
    }
    notify(id)
  }

  /// JS's ATT error code (the same values as `CBATTError.Code`); an unknown one is an unlikely error.
  static func code(_ attError: Int?) -> CBATTError.Code {
    attError.flatMap { CBATTError.Code(rawValue: $0) } ?? .unlikelyError
  }

  /// One value per characteristic, assembled in order from a request array's parts; or the error.
  private enum Assembled {
    case values([(CBUUID, Data)])
    case failure(CBATTError.Code)
  }

  private func assemble(_ requests: [ATTRequestLike]) -> Assembled {
    var values: [(CBUUID, Data)] = []
    for request in requests {
      guard let spec = characteristics[request.characteristicUUID], spec.value == nil else {
        return .failure(.writeNotPermitted)
      }
      if !values.contains(where: { $0.0 == spec.uuid }) { values.append((spec.uuid, Data())) }
      guard let index = values.firstIndex(where: { $0.0 == spec.uuid }) else { continue }
      var current = values[index].1
      let part = request.value ?? Data()
      let end = request.offset + part.count
      if request.offset > current.count { return .failure(.invalidOffset) }
      if end > Self.maxValueLength { return .failure(.invalidAttributeValueLength) }
      if current.count < end { current.append(Data(count: end - current.count)) }
      current.replaceSubrange(request.offset..<end, with: part)
      values[index].1 = current
    }
    return .values(values)
  }
}

/// What the server tells the binding (and through it, JS).
protocol GattServerListener: AnyObject {
  func gattServer(_ server: GattServer, readRequest id: Int, central: UUID, characteristic: CBUUID, offset: Int)
  // swiftlint:disable:next function_parameter_count
  func gattServer(
    _ server: GattServer,
    writeRequest id: Int,
    central: UUID,
    characteristic: CBUUID,
    offset: Int,
    value: Data,
    withResponse: Bool
  )
  func gattServer(_ server: GattServer, central: UUID, characteristic: CBUUID, subscribed: Bool)
  func gattServer(_ server: GattServer, warning: CoreError)
}

extension GattServer: PeripheralManagingDelegate {
  func peripheralManagerDidUpdateState(_ manager: PeripheralManaging) {
    guard let waiting, manager.state != .unknown, manager.state != .resetting else { return }
    waiting.timeout.cancel()
    self.waiting = nil
    start(waiting.completion)
  }

  func peripheralManager(_ manager: PeripheralManaging, didAdd service: CBUUID, error: Error?) {
    guard let adding, adding.remaining.first?.uuid == service else { return }
    adding.timeout.cancel()
    self.adding = nil
    if let error {
      close()
      return adding.completion(CoreError(.gattError, "iOS couldn't add service \(service.uuidString): \(error)"))
    }
    addNext(Array(adding.remaining.dropFirst()), adding.completion)
  }

  func peripheralManager(_ manager: PeripheralManaging, didReceiveRead request: ATTRequestLike) {
    let uuid = request.characteristicUUID
    guard let spec = characteristics[uuid] else {
      return manager.respond(to: request, withResult: .attributeNotFound)
    }
    if let value = spec.value { return answerRead(request, value: value) }
    if let cached = readCache.lookup(central: request.centralId, characteristic: uuid, offset: request.offset) {
      return answerRead(request, value: cached)
    }
    ask(Pending(isRead: true, request: request, characteristic: uuid, group: nil)) { id in
      listener?.gattServer(
        self, readRequest: id, central: request.centralId, characteristic: uuid, offset: request.offset
      )
    }
  }

  func peripheralManager(_ manager: PeripheralManaging, didReceiveWrite requests: [ATTRequestLike]) {
    guard let first = requests.first else { return }
    switch assemble(requests) {
    case .failure(let code):
      manager.respond(to: first, withResult: code)
    case .values(let values):
      let group = ExecuteGroup(first: first, remaining: values.count)
      for (uuid, value) in values {
        // iOS doesn't tell write types apart; a characteristic that only allows writes without
        // response can only have received those.
        let withResponse = characteristics[uuid]?.properties.contains(.write) ?? true
        ask(Pending(isRead: false, request: first, characteristic: uuid, group: group)) { id in
          listener?.gattServer(
            self,
            writeRequest: id,
            central: first.centralId,
            characteristic: uuid,
            offset: 0,
            value: value,
            withResponse: withResponse
          )
        }
      }
    }
  }

  func peripheralManager(_ manager: PeripheralManaging, central: UUID, didSubscribeTo characteristic: CBUUID) {
    if subscribers[characteristic, default: []].insert(central).inserted {
      listener?.gattServer(self, central: central, characteristic: characteristic, subscribed: true)
    }
  }

  func peripheralManager(_ manager: PeripheralManaging, central: UUID, didUnsubscribeFrom characteristic: CBUUID) {
    if subscribers[characteristic]?.remove(central) != nil {
      listener?.gattServer(self, central: central, characteristic: characteristic, subscribed: false)
    }
  }
}
