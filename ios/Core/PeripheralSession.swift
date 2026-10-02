import CoreBluetooth
import Foundation

/// Native connection states (plan §4.8).
enum SessionState {
  case disconnected
  case connecting
  /// The link is up; post-connect setup is running.
  case connected
  /// `autoDiscover` is running before the connection is ready.
  case discovering
  /// Link up and setup done: what JS calls `connected`.
  case ready
  case disconnecting

  /// JS `ConnectionState` (plan §4.8).
  var js: String {
    switch self {
    case .disconnected:
      return "disconnected"
    case .connecting, .connected, .discovering:
      return "connecting"
    case .ready:
      return "connected"
    case .disconnecting:
      return "disconnecting"
    }
  }
}

/// Connect options after the TS layer applied its defaults (plan §5.4).
struct ConnectSpec {
  /// Nil: no timeout, a pending connect that completes when the device appears. Only an explicit JS
  /// `timeoutMs: null` gets here.
  var timeout: TimeInterval?
  var notifyOnDisconnection = false
  /// Discover every service before the connection counts as ready (plan §4.8).
  var autoDiscover = true
}

/// One peripheral's connection (plan §4.3, §4.8): connect with a timeout that cancels the pending
/// connection (CoreBluetooth never times out on its own), service discovery and its cache,
/// disconnect, and link loss.
///
/// Threading (plan §4.7): everything on the engine's queue. The engine publishes `state` for
/// synchronous reads.
final class PeripheralSession: PeripheralLikeDelegate {
  typealias Completion = (CoreError?) -> Void
  typealias DiscoveryCompletion = (Result<[DiscoveredService], CoreError>) -> Void

  /// One discovery run: services, then characteristics, then descriptors (plan §4.9).
  private struct DiscoveryRun {
    let id: Int
    let filter: [String]?
    /// Characteristic and descriptor discoveries still outstanding.
    var outstanding = 0
  }

  let peripheral: PeripheralLike
  /// Operations on this connection (Appendix B rule 2). Used from P1-06 on.
  let queue: GattQueue
  /// Called on changes of the JS state only; `error` is set when the connection ended or failed
  /// unexpectedly.
  var onStateChange: ((SessionState, CoreError?) -> Void)?
  private(set) var state = SessionState.disconnected
  /// The discovery cache, by service UUID in discovery order. Empty when disconnected.
  private(set) var services: [DiscoveredService] = []
  /// Called after the cache changes.
  var onServicesChange: (([DiscoveredService]) -> Void)?

  private let central: CentralManaging
  private let scheduler: Scheduling
  private var connectTimeout: CancellableWork?
  private var disconnectTimeout: CancellableWork?
  private var connectWaiters: [Completion] = []
  private var disconnectWaiters: [() -> Void] = []
  private var autoDiscover = true
  private var discovery: DiscoveryRun?
  /// A write without response waiting for `canSendWriteWithoutResponse` (basic pacing; P2-02 adds
  /// flow control).
  var pendingWriteWithoutResponse: (() -> Void)?
  private var nextDiscoveryId = 0

  static let disconnectTimeout: TimeInterval = 5
  /// Discovery is one queued operation, and slower than the 10 s default (plan §4.9).
  static let discoveryTimeout: TimeInterval = 30

  init(peripheral: PeripheralLike, central: CentralManaging, scheduler: Scheduling) {
    self.peripheral = peripheral
    self.central = central
    self.scheduler = scheduler
    queue = GattQueue(scheduler: scheduler)
    peripheral.delegate = self
  }

  /// Completes with nil once the connection is ready. A connect while one is pending joins it, with
  /// the first call's options.
  func connect(_ spec: ConnectSpec, completion: @escaping Completion) {
    switch state {
    case .ready:
      completion(nil)
    case .connecting, .connected, .discovering:
      connectWaiters.append(completion)
    case .disconnecting:
      disconnectWaiters.append { [weak self] in self?.connect(spec, completion: completion) }
    case .disconnected:
      connectWaiters.append(completion)
      autoDiscover = spec.autoDiscover
      setState(.connecting, nil)
      if let timeout = spec.timeout {
        connectTimeout = scheduler.schedule(after: timeout) { [weak self] in
          guard let self else {
            return
          }
          connectTimeout = nil
          let milliseconds = Int(timeout * 1000)
          failConnect(CoreError(.connectionTimeout, "Connecting timed out after \(milliseconds) ms"))
        }
      }
      var options: [String: Any] = [:]
      if spec.notifyOnDisconnection {
        options[CBConnectPeripheralOptionNotifyOnDisconnectionKey] = true
      }
      central.connect(peripheral, options: options.isEmpty ? nil : options)
    }
  }

  /// Completes once disconnected. During a connect, it cancels the attempt, which then fails with
  /// OPERATION_CANCELLED.
  func disconnect(completion: @escaping () -> Void) {
    switch state {
    case .disconnected:
      completion()
    case .disconnecting:
      disconnectWaiters.append(completion)
    case .connecting, .connected, .discovering:
      disconnectWaiters.append(completion)
      failConnect(nil, connectError: CoreError(.operationCancelled, "disconnect() cancelled the connection attempt"))
    case .ready:
      disconnectWaiters.append(completion)
      setState(.disconnecting, nil)
      central.cancelPeripheralConnection(peripheral)
      // Rule 4: if CoreBluetooth never confirms, report disconnected anyway.
      disconnectTimeout = scheduler.schedule(after: Self.disconnectTimeout) { [weak self] in
        self?.disconnectTimeout = nil
        self?.finishDisconnected(nil)
      }
    }
  }

  /// Discovers services through the queue (plan §4.9): `filter` (all when nil), then all their
  /// characteristics and descriptors. The cache gains what was found; an unfiltered run replaces it.
  func discover(_ filter: [String]?, timeout: TimeInterval?, completion: @escaping DiscoveryCompletion) {
    guard state == .ready || state == .discovering else {
      return completion(.failure(CoreError(.disconnected, "Not connected")))
    }
    nextDiscoveryId += 1
    let runId = nextDiscoveryId
    queue.enqueue(
      .discoverServices,
      timeout: timeout ?? Self.discoveryTimeout,
      start: { [weak self] in
        self?.discovery = DiscoveryRun(id: runId, filter: filter)
        self?.peripheral.discoverServices(filter?.map(CBUUID.init(string:)))
      },
      completion: { [weak self] result in
        guard let self else {
          return
        }
        if discovery?.id == runId {
          // A timeout or a disconnect ended the run; later callbacks are ignored.
          discovery = nil
        }
        completion(result.map { _ in self.updateCache(filter) })
      }
    )
  }

  /// Bluetooth went away: CoreBluetooth drops every connection without callbacks.
  func forceDisconnected(_ error: CoreError) {
    guard state != .disconnected else {
      return
    }
    finishDisconnected(error)
  }

  // MARK: Central callbacks, routed here by the engine

  func didConnect() {
    switch state {
    case .connecting:
      // The connect timeout keeps running through setup: connect() covers it all (plan §4.8).
      setState(.connected, nil)
      guard autoDiscover else {
        return becomeReady()
      }
      setState(.discovering, nil)
      discover(nil, timeout: nil) { [weak self] result in
        guard let self, state == .discovering else {
          return
        }
        switch result {
        case .success:
          becomeReady()
        case let .failure(error):
          failConnect(error)
        }
      }
    case .disconnected:
      // A connect we gave up on completed anyway: drop the link.
      central.cancelPeripheralConnection(peripheral)
    default:
      break
    }
  }

  func didFailToConnect(_ error: Error?) {
    guard state == .connecting else {
      return
    }
    failConnect(Self.connectionError(error))
  }

  func didDisconnect(_ error: Error?) {
    switch state {
    case .connecting, .connected, .discovering:
      // Before ready, a dropped link is a failed connect.
      failConnect(Self.connectionError(error))
    case .ready:
      let lost = error.map(CoreBluetoothErrorMapping.coreError(from:))
        ?? CoreError(.disconnected, "The peripheral disconnected")
      finishDisconnected(lost)
    case .disconnecting:
      finishDisconnected(nil)
    case .disconnected:
      break
    }
  }

  // MARK: Private

  private func becomeReady() {
    connectTimeout?.cancel()
    connectTimeout = nil
    setState(.ready, nil)
    // The state listener has seen `connected` before connect() resolves (plan §4.8).
    let waiters = connectWaiters
    connectWaiters.removeAll()
    waiters.forEach { $0(nil) }
  }

  /// A failed connect is CONNECTION_FAILED whatever CoreBluetooth called it; the native code is kept.
  static func connectionError(_ error: Error?) -> CoreError {
    guard let error else {
      return CoreError(.connectionFailed, "The connection failed")
    }
    let mapped = CoreBluetoothErrorMapping.coreError(from: error)
    return CoreError(
      .connectionFailed,
      mapped.message,
      retryable: true,
      nativeDomain: mapped.nativeDomain,
      nativeCode: mapped.nativeCode
    )
  }

  /// Ends a connect attempt. `error` goes to the state listener; `connectError` to connect() callers.
  private func failConnect(_ error: CoreError?, connectError: CoreError? = nil) {
    // CoreBluetooth keeps a pending connect forever unless it is cancelled (plan §4.3).
    central.cancelPeripheralConnection(peripheral)
    finishDisconnected(error, connectError: connectError)
  }

  private func finishDisconnected(_ error: CoreError?, connectError: CoreError? = nil) {
    connectTimeout?.cancel()
    connectTimeout = nil
    disconnectTimeout?.cancel()
    disconnectTimeout = nil
    pendingWriteWithoutResponse = nil
    // Handles and the database can differ on the next connection.
    if !services.isEmpty {
      services = []
      onServicesChange?([])
    }
    // The state changes first, so callbacks of the operations failed below see the final state.
    setState(.disconnected, error)
    queue.failAll(CoreError(.disconnected, "Disconnected"))
    let connectFailure = connectError ?? error
      ?? CoreError(.disconnected, "Disconnected before the connection was ready")
    let connects = connectWaiters
    connectWaiters.removeAll()
    connects.forEach { $0(connectFailure) }
    let disconnects = disconnectWaiters
    disconnectWaiters.removeAll()
    disconnects.forEach { $0() }
  }

  private func setState(_ newState: SessionState, _ error: CoreError?) {
    let previous = state
    state = newState
    if newState.js != previous.js {
      onStateChange?(newState, error)
    }
  }
}

// MARK: - Discovery callbacks

extension PeripheralSession {
  func peripheralDidDiscoverServices(_ peripheral: PeripheralLike, error: Error?) {
    guard var run = discovery else {
      return
    }
    if let error {
      return finishDiscovery(.failure(CoreBluetoothErrorMapping.coreError(from: error)))
    }
    let services = peripheral.serviceList.filter { run.filter?.contains($0.uuid.fullUUIDString) ?? true }
    run.outstanding = services.count
    discovery = run
    if services.isEmpty {
      return finishDiscovery(.success(.none))
    }
    services.forEach { peripheral.discoverCharacteristics(nil, for: $0) }
  }

  func peripheral(_ peripheral: PeripheralLike, didDiscoverCharacteristicsFor service: ServiceLike, error: Error?) {
    guard discovery != nil else {
      return
    }
    if let error {
      return finishDiscovery(.failure(CoreBluetoothErrorMapping.coreError(from: error)))
    }
    discovery?.outstanding += service.characteristicList.count - 1
    service.characteristicList.forEach { peripheral.discoverDescriptors(for: $0) }
    finishDiscoveryIfDone()
  }

  func peripheral(
    _ peripheral: PeripheralLike,
    didDiscoverDescriptorsFor characteristic: CharacteristicLike,
    error: Error?
  ) {
    guard discovery != nil else {
      return
    }
    if let error {
      return finishDiscovery(.failure(CoreBluetoothErrorMapping.coreError(from: error)))
    }
    discovery?.outstanding -= 1
    finishDiscoveryIfDone()
  }

  private func finishDiscoveryIfDone() {
    if let run = discovery, run.outstanding == 0 {
      finishDiscovery(.success(.none))
    }
  }

  private func finishDiscovery(_ result: Result<GattOperation.Output, CoreError>) {
    discovery = nil
    queue.complete(result) { $0.kind == .discoverServices }
  }

  /// Records what the run found and returns the services it asked for.
  private func updateCache(_ filter: [String]?) -> [DiscoveredService] {
    let found = peripheral.serviceList
      .filter { filter?.contains($0.uuid.fullUUIDString) ?? true }
      .map(DiscoveredService.init)
    if filter == nil {
      services = found
    } else {
      for service in found {
        if let index = services.firstIndex(where: { $0.uuid == service.uuid }) {
          services[index] = service
        } else {
          services.append(service)
        }
      }
    }
    onServicesChange?(services)
    return found
  }
}
