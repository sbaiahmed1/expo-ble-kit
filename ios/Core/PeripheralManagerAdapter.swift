import CoreBluetooth
import Foundation

/// `PeripheralManaging` on a real `CBPeripheralManager`, created on the peripheral queue (plan §4.4).
final class CBPeripheralManagerAdapter: NSObject, PeripheralManaging {
  /// How long a read or write that arrives before the GATT server opens waits for it (P4-04): after
  /// a background relaunch, until the app's JS opens the server again.
  static let heldRequestTimeout: TimeInterval = 20

  /// After the GATT server attaches, held requests wait this long for its JS handlers, which the
  /// app adds once `openGattServer` resolved.
  static let heldRequestGrace: TimeInterval = 1

  weak var delegate: PeripheralManagingDelegate? {
    didSet {
      guard delegate != nil, !heldRequests.isEmpty else { return }
      queue.asyncAfter(deadline: .now() + Self.heldRequestGrace) { [weak self] in self?.releaseHeldRequests() }
    }
  }
  weak var advertisingDelegate: PeripheralAdvertisingDelegate?
  weak var l2capDelegate: PeripheralL2CAPDelegate?
  /// P4-04: what state restoration handed back, for the journal: services and advertisement.
  var onRestore: ((_ services: [CBUUID], _ advertisement: [String: Any]?) -> Void)?
  private var manager: CBPeripheralManager!
  /// Where L2CAP channel streams report (P5-03): the peripheral queue.
  private let queue: DispatchQueue
  /// What notifications need: the published characteristics and the subscribed centrals.
  private var characteristics: [CBUUID: CBMutableCharacteristic] = [:]
  private var centrals: [UUID: CBCentral] = [:]
  private(set) var restoredServices: [CBUUID] = []
  private var restoredSubscriptions: [(central: CBCentral, characteristic: CBUUID)] = []
  /// A request that arrived while no GATT server was open.
  private struct HeldRequest {
    let arrived: Date
    let deliver: (PeripheralManagingDelegate) -> Void
    let reject: () -> Void
  }

  private var heldRequests: [HeldRequest] = []

  /// `restoreIdentifier`: P4-04, iOS keeps the services and the advertisement while the app isn't
  /// running and hands them back to the manager created with it.
  init(queue: DispatchQueue, restoreIdentifier: String? = nil) {
    self.queue = queue
    super.init()
    var options: [String: Any] = [CBPeripheralManagerOptionShowPowerAlertKey: false]
    if let restoreIdentifier {
      options[CBPeripheralManagerOptionRestoreIdentifierKey] = restoreIdentifier
    }
    // With a restore identifier, CoreBluetooth asserts that the delegate it gets here implements
    // willRestoreState.
    manager = CBPeripheralManager(delegate: self, queue: queue, options: options)
  }

  func adoptRestoredServices() {
    let subscriptions = restoredSubscriptions
    restoredSubscriptions.removeAll()
    for subscription in subscriptions {
      centrals[subscription.central.identifier] = subscription.central
      let central = subscription.central.identifier
      delegate?.peripheralManager(self, central: central, didSubscribeTo: subscription.characteristic)
    }
  }

  /// Keeps a request for the GATT server JS opens next; answers it with an error after the timeout.
  private func hold(_ deliver: @escaping (PeripheralManagingDelegate) -> Void, reject: @escaping () -> Void) {
    heldRequests.append(HeldRequest(arrived: Date(), deliver: deliver, reject: reject))
    queue.asyncAfter(deadline: .now() + Self.heldRequestTimeout) { [weak self] in
      guard let self else { return }
      let now = Date()
      let expired = heldRequests.filter { now.timeIntervalSince($0.arrived) >= Self.heldRequestTimeout }
      heldRequests.removeAll { now.timeIntervalSince($0.arrived) >= Self.heldRequestTimeout }
      expired.forEach { $0.reject() }
    }
  }

  private func releaseHeldRequests() {
    guard let delegate, !heldRequests.isEmpty else { return }
    let held = heldRequests
    heldRequests.removeAll()
    held.forEach { $0.deliver(delegate) }
  }

  var state: CBManagerState { manager.state }

  func add(_ service: ServerServiceSpec) {
    let mutable = service.mutableService()
    for case let characteristic as CBMutableCharacteristic in mutable.characteristics ?? [] {
      characteristics[characteristic.uuid] = characteristic
    }
    manager.add(mutable)
  }

  func removeAllServices() {
    manager.removeAllServices()
    characteristics.removeAll()
    restoredServices.removeAll()
    restoredSubscriptions.removeAll()
  }

  func updateValue(_ value: Data, for characteristic: CBUUID, onSubscribedCentrals centrals: [UUID]) -> Bool {
    guard let target = characteristics[characteristic] else { return true }
    let subscribed = centrals.compactMap { self.centrals[$0] }
    guard !subscribed.isEmpty else { return true }
    return manager.updateValue(value, for: target, onSubscribedCentrals: subscribed)
  }

  func maximumUpdateValueLength(for central: UUID) -> Int? {
    centrals[central]?.maximumUpdateValueLength
  }

  func respond(to request: ATTRequestLike, withResult result: CBATTError.Code) {
    guard let request = request as? ATTRequestAdapter else { return }
    manager.respond(to: request.request, withResult: result)
  }

  func startAdvertising(localName: String?, serviceUUIDs: [CBUUID]) {
    // One advertisement at a time; after state restoration iOS resumes the earlier one by itself
    // (P4-04), and starting over it fails with "Advertising has already started".
    if manager.isAdvertising {
      manager.stopAdvertising()
    }
    var data: [String: Any] = [:]
    if let localName { data[CBAdvertisementDataLocalNameKey] = localName }
    if !serviceUUIDs.isEmpty { data[CBAdvertisementDataServiceUUIDsKey] = serviceUUIDs }
    manager.startAdvertising(data.isEmpty ? nil : data)
  }

  func stopAdvertising() {
    manager.stopAdvertising()
  }

  func publishL2CAPChannel(withEncryption encryptionRequired: Bool) {
    manager.publishL2CAPChannel(withEncryption: encryptionRequired)
  }

  func unpublishL2CAPChannel(_ psm: CBL2CAPPSM) {
    manager.unpublishL2CAPChannel(psm)
  }
}

extension CBPeripheralManagerAdapter: CBPeripheralManagerDelegate {
  /// P4-04: the services and advertisement iOS kept; called before the first state update.
  func peripheralManager(_ peripheral: CBPeripheralManager, willRestoreState dict: [String: Any]) {
    let services = dict[CBPeripheralManagerRestoredStateServicesKey] as? [CBMutableService] ?? []
    for service in services {
      for case let characteristic as CBMutableCharacteristic in service.characteristics ?? [] {
        characteristics[characteristic.uuid] = characteristic
        for central in characteristic.subscribedCentrals ?? [] {
          restoredSubscriptions.append((central, characteristic.uuid))
        }
      }
    }
    restoredServices = services.map(\.uuid)
    onRestore?(restoredServices, dict[CBPeripheralManagerRestoredStateAdvertisementDataKey] as? [String: Any])
  }

  func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
    delegate?.peripheralManagerDidUpdateState(self)
    advertisingDelegate?.peripheralManagerStateChanged(self)
    l2capDelegate?.peripheralManagerStateChanged(self)
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didPublishL2CAPChannel PSM: CBL2CAPPSM, error: Error?) {
    l2capDelegate?.peripheralManager(self, didPublishL2CAPChannel: PSM, error: error)
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didOpen channel: CBL2CAPChannel?, error: Error?) {
    l2capDelegate?.peripheralManager(
      self,
      didOpen: channel.map { CBL2CAPChannelAdapter($0, queue: queue) },
      error: error
    )
  }

  func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
    advertisingDelegate?.peripheralManagerDidStartAdvertising(self, error: error)
  }

  func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
    delegate?.peripheralManagerIsReady(toUpdateSubscribers: self)
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
    delegate?.peripheralManager(self, didAdd: service.uuid, error: error)
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
    let adapted = ATTRequestAdapter(request)
    guard let delegate else {
      return hold({ $0.peripheralManager(self, didReceiveRead: adapted) }, reject: {
        peripheral.respond(to: request, withResult: .unlikelyError)
      })
    }
    delegate.peripheralManager(self, didReceiveRead: adapted)
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
    let adapted = requests.map(ATTRequestAdapter.init)
    guard let delegate else {
      return hold({ $0.peripheralManager(self, didReceiveWrite: adapted) }, reject: {
        if let first = requests.first { peripheral.respond(to: first, withResult: .unlikelyError) }
      })
    }
    delegate.peripheralManager(self, didReceiveWrite: adapted)
  }

  func peripheralManager(
    _ peripheral: CBPeripheralManager,
    central: CBCentral,
    didSubscribeTo characteristic: CBCharacteristic
  ) {
    centrals[central.identifier] = central
    delegate?.peripheralManager(self, central: central.identifier, didSubscribeTo: characteristic.uuid)
  }

  func peripheralManager(
    _ peripheral: CBPeripheralManager,
    central: CBCentral,
    didUnsubscribeFrom characteristic: CBCharacteristic
  ) {
    delegate?.peripheralManager(self, central: central.identifier, didUnsubscribeFrom: characteristic.uuid)
  }
}

/// `ATTRequestLike` over a `CBATTRequest`.
final class ATTRequestAdapter: ATTRequestLike {
  let request: CBATTRequest

  init(_ request: CBATTRequest) {
    self.request = request
  }

  var centralId: UUID { request.central.identifier }
  var characteristicUUID: CBUUID { request.characteristic.uuid }
  var offset: Int { request.offset }
  var value: Data? {
    get { request.value }
    set { request.value = newValue }
  }
}

extension ServerServiceSpec {
  /// The CoreBluetooth service. A static value is cached by iOS, which makes the characteristic
  /// read-only; iOS adds the CCCD of notifiable characteristics itself.
  func mutableService() -> CBMutableService {
    let service = CBMutableService(type: uuid, primary: primary)
    service.characteristics = characteristics.map { spec in
      let characteristic = CBMutableCharacteristic(
        type: spec.uuid,
        properties: spec.properties,
        value: spec.value,
        permissions: spec.permissions
      )
      characteristic.descriptors = spec.descriptors.map { descriptor in
        // A user description descriptor takes a string, a format descriptor the bytes.
        let isDescription = descriptor.uuid == CBUUID(string: CBUUIDCharacteristicUserDescriptionString)
        let value: Any = isDescription ? String(bytes: descriptor.value, encoding: .utf8) ?? "" : descriptor.value
        return CBMutableDescriptor(type: descriptor.uuid, value: value)
      }
      return characteristic
    }
    return service
  }
}
