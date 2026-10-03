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
  /// Waiting before the next reconnection attempt (P2-01). JS also sees the attempts as this.
  case reconnecting

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
    case .reconnecting:
      return "reconnecting"
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
  /// Reconnect after an unexpected link loss of a ready connection; nil never does (P2-01).
  var reconnect: ReconnectPolicy?
  /// With `reconnect`: enable the subscriptions again before the connection counts as ready.
  var restoreSubscriptions = true
  /// iOS 17+: let the system reconnect (CBConnectPeripheralOptionEnableAutoReconnect), with `reconnect`.
  var enableAutoReconnect = false
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
  struct DiscoveryRun {
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
  /// Set by discovery only.
  var services: [DiscoveredService] = []
  /// Called after the cache changes.
  var onServicesChange: (([DiscoveredService]) -> Void)?
  /// ATT MTU, derived (P1-09). 23 until the connection is ready. Only the session sets it.
  var mtu = PeripheralSession.defaultMtu
  /// A changed MTU on a ready connection.
  var onMtuChange: ((Int) -> Void)?
  /// The name iOS cached for the peripheral: when the connection is ready, then on each change.
  var onNameChange: ((String?) -> Void)?
  /// Subscriptions that end while the connection lives on (reconnecting): a reconnection without
  /// subscription restore, or a restore that failed.
  var onSubscriptionEnded: ((_ subscriptionId: Int, CoreError) -> Void)?

  /// The reconnection attempt running or waiting (1-based); 0 when not reconnecting (P2-01).
  var reconnectAttempt = 0
  /// The system reconnects on its own (iOS 17 auto-reconnect); no attempts of ours run.
  var systemReconnecting = false
  var reconnect: ReconnectPolicy?
  var restoreSubscriptions = true
  var connectTimeoutValue: TimeInterval?
  var connectOptions: [String: Any]?
  var reconnectTimer: CancellableWork?
  /// The state the listener last heard, as JS sees it.
  private var reported = SessionState.disconnected

  let central: CentralManaging
  let scheduler: Scheduling
  var connectTimeout: CancellableWork?
  private var disconnectTimeout: CancellableWork?
  private var connectWaiters: [Completion] = []
  private var disconnectWaiters: [() -> Void] = []
  private var autoDiscover = true
  /// The discovery in flight, if any. Only the discovery code uses it.
  var discovery: DiscoveryRun?
  /// A write without response waiting for `canSendWriteWithoutResponse` (flow control, P2-02).
  var pendingWriteWithoutResponse: (() -> Void)?
  /// Subscriptions by characteristic key, one CCCD each (plan §5.4).
  var subscriptions: [String: CharacteristicSubscriptions] = [:]
  /// Characteristic key of every active or pending subscription id.
  var subscriptionKeys: [Int: String] = [:]
  /// Running and queued operations JS may cancel, by the id JS gave them.
  var cancellable: [Int: GattOperation] = [:]
  /// Notifications and indications of subscribed characteristics, on the engine's queue.
  var onNotification: ((CharacteristicLike, Data) -> Void)?
  var nextDiscoveryId = 0

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
    case .connecting, .connected, .discovering, .reconnecting:
      connectWaiters.append(completion)
    case .disconnecting:
      disconnectWaiters.append { [weak self] in self?.connect(spec, completion: completion) }
    case .disconnected:
      connectWaiters.append(completion)
      autoDiscover = spec.autoDiscover
      reconnect = spec.reconnect
      restoreSubscriptions = spec.restoreSubscriptions
      connectTimeoutValue = spec.timeout
      connectOptions = Self.options(for: spec)
      setState(.connecting, nil)
      startConnectTimeout()
      central.connect(peripheral, options: connectOptions)
    }
  }

  /// Fails the connect, or the reconnection attempt, once the spec's timeout passes.
  func startConnectTimeout() {
    guard let timeout = connectTimeoutValue else {
      return
    }
    connectTimeout = scheduler.schedule(after: timeout) { [weak self] in
      guard let self else {
        return
      }
      connectTimeout = nil
      let milliseconds = Int(timeout * 1000)
      failConnect(CoreError(.connectionTimeout, "Connecting timed out after \(milliseconds) ms"))
    }
  }

  private static func options(for spec: ConnectSpec) -> [String: Any]? {
    var options: [String: Any] = [:]
    if spec.notifyOnDisconnection {
      options[CBConnectPeripheralOptionNotifyOnDisconnectionKey] = true
    }
    if spec.reconnect != nil, spec.enableAutoReconnect, #available(iOS 17, macOS 14, *) {
      options[CBConnectPeripheralOptionEnableAutoReconnect] = true
    }
    return options.isEmpty ? nil : options
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
    case .reconnecting:
      disconnectWaiters.append(completion)
      finishDisconnected(nil, connectError: CoreError(.operationCancelled, "disconnect() stopped reconnecting"))
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
      // Restoring subscriptions needs their characteristics, whatever autoDiscover says.
      let restoring = reconnectAttempt > 0 && !subscriptions.isEmpty
      guard autoDiscover || restoring else {
        return restoreSubscriptions { [weak self] in self?.becomeReady() }
      }
      setState(.discovering, nil)
      let filter = autoDiscover ? nil : Array(Set(subscriptions.values.map(\.serviceUUID.fullUUIDString)))
      discover(filter, timeout: nil) { [weak self] result in
        guard let self, state == .discovering else {
          return
        }
        switch result {
        case .success:
          restoreSubscriptions { [weak self] in self?.becomeReady() }
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

  /// `isReconnecting`: iOS 17 auto-reconnect will connect again by itself.
  func didDisconnect(_ error: Error?, isReconnecting: Bool = false) {
    switch state {
    case .connecting, .connected, .discovering:
      // Before ready, a dropped link is a failed connect (or reconnection attempt).
      failConnect(Self.connectionError(error))
    case .ready:
      let lost = error.map(CoreBluetoothErrorMapping.coreError(from:))
        ?? CoreError(.disconnected, "The peripheral disconnected")
      if reconnect != nil {
        startReconnecting(lost, system: isReconnecting)
      } else {
        if isReconnecting {
          central.cancelPeripheralConnection(peripheral)
        }
        finishDisconnected(lost)
      }
    case .disconnecting:
      finishDisconnected(nil)
    case .disconnected, .reconnecting:
      break
    }
  }

  // MARK: Private

  private func becomeReady() {
    connectTimeout?.cancel()
    connectTimeout = nil
    reconnectAttempt = 0
    systemReconnecting = false
    mtu = derivedMtu
    onNameChange?(peripheral.name)
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
  /// A failed reconnection attempt waits for the next one instead.
  func failConnect(_ error: CoreError?, connectError: CoreError? = nil) {
    // CoreBluetooth keeps a pending connect forever unless it is cancelled (plan §4.3).
    central.cancelPeripheralConnection(peripheral)
    if reconnectAttempt > 0, let error {
      retryReconnect(error)
    } else {
      finishDisconnected(error, connectError: connectError)
    }
  }

  func finishDisconnected(_ error: CoreError?, connectError: CoreError? = nil) {
    connectTimeout?.cancel()
    connectTimeout = nil
    disconnectTimeout?.cancel()
    disconnectTimeout = nil
    reconnectTimer?.cancel()
    reconnectTimer = nil
    reconnectAttempt = 0
    systemReconnecting = false
    pendingWriteWithoutResponse = nil
    // Handles, the database and the MTU can differ on the next connection.
    mtu = Self.defaultMtu
    if !services.isEmpty {
      services = []
      onServicesChange?([])
    }
    // The state changes first, so callbacks of the operations failed below see the final state.
    setState(.disconnected, error)
    queue.failAll(CoreError(.disconnected, "Disconnected"))
    // Subscriptions end with the connection (plan §4.8); a reconnection keeps them (P2-01).
    subscriptions.removeAll()
    subscriptionKeys.removeAll()
    let connectFailure = connectError ?? error
      ?? CoreError(.disconnected, "Disconnected before the connection was ready")
    let connects = connectWaiters
    connectWaiters.removeAll()
    connects.forEach { $0(connectFailure) }
    let disconnects = disconnectWaiters
    disconnectWaiters.removeAll()
    disconnects.forEach { $0() }
  }

  /// The listener hears changes of the JS state only (plan §4.8 maps several native states to one).
  func setState(_ newState: SessionState, _ error: CoreError?) {
    state = newState
    let now = visibleState
    if now.js != reported.js {
      reported = now
      onStateChange?(now, error)
    }
  }

  /// The state as JS sees it: the setup steps of a reconnection read as `reconnecting` (plan §4.8).
  var visibleState: SessionState {
    let settingUp = state == .connecting || state == .connected || state == .discovering
    return reconnectAttempt > 0 && settingUp ? .reconnecting : state
  }
}
