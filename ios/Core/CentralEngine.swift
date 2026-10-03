import CoreBluetooth
import Foundation

/// Owns the central manager (plan §4.3): adapter state and permissions (P1-03), scanning (P1-04)
/// and peripheral sessions (P1-05).
///
/// Threading (plan §4.7): call everything except `state` on `queue`. Callbacks run on `queue`.
final class CentralEngine: CentralManagingDelegate {
  static let usageDescriptionKey = "NSBluetoothAlwaysUsageDescription"

  /// What the engine reads from the system. Injected so tests can script it.
  struct Environment {
    /// `CBManager.authorization`. Reading it never shows the prompt.
    var authorization: () -> CBManagerAuthorization
    /// The app's Info.plist.
    var infoDictionary: () -> [String: Any]?
    var makeCentral: CentralManagerFactory

    static let live = Environment(
      authorization: { CBManager.authorization },
      infoDictionary: { Bundle.main.infoDictionary },
      makeCentral: CBCentralManagerAdapter.factory
    )
  }

  typealias PermissionsCompletion = (Result<BlePermissions, CoreError>) -> Void

  let queue: DispatchQueue
  /// Called on `queue` after the published state changes.
  var onStateChange: ((BleState) -> Void)?
  let scanController: ScanController
  /// Called on `queue` when a peripheral's JS connection state changes; `error` is set when the
  /// connection ended or failed unexpectedly.
  var onConnectionStateChange: ((_ peripheralId: String, SessionState, CoreError?) -> Void)?
  /// A subscription ended while its connection reconnects (P2-01), on `queue`.
  var onSubscriptionEnded: ((_ peripheralId: String, _ subscriptionId: Int, CoreError) -> Void)?
  /// A notification or indication, on `queue`; the timestamp is epoch milliseconds (plan §4.10).
  var onNotification: ((_ peripheralId: String, _ service: String, _ characteristic: String, Data, Double) -> Void)?
  /// The MTU of a ready connection changed (P1-09), on `queue`.
  var onMtuChange: ((_ peripheralId: String, Int) -> Void)?
  /// A batched subscriber's values (P2-04), on `queue`.
  var onNotificationBatch: ((_ peripheralId: String, _ subscriptionId: Int, NotificationBatch) -> Void)?
  /// Something worth telling the app that isn't an error of a call, on `queue`.
  var onWarning: ((CoreError) -> Void)?

  private let environment: Environment
  private let scheduler: Scheduling
  private let clock: EpochClock
  private(set) var sessions: [UUID: PeripheralSession] = [:]
  /// Advertised names from scans, then the names iOS caches for connected peripherals (plan §4.7).
  let names = PeripheralNames()
  /// Work waiting for a new manager to leave `unknown`, by peripheral (connects) or a random id.
  private var pendingConnects: [(id: UUID, run: (Result<CentralManaging, CoreError>) -> Void)] = []
  /// JS connection states by peripheral id, for synchronous reads. Guarded by `stateLock`.
  private var connectionStates: [String: String] = [:]
  /// Discovery caches by peripheral id, for synchronous reads. Guarded by `stateLock`.
  private var discoveredServices: [String: [DiscoveredService]] = [:]
  /// MTUs by peripheral id, for synchronous reads. Guarded by `stateLock`.
  private var mtus: [String: Int] = [:]
  private(set) var central: CentralManaging?
  private var pendingPermissionRequests: [PermissionsCompletion] = []

  private let stateLock = NSLock()
  private var publishedState: BleState

  init(queue: DispatchQueue, environment: Environment = .live, scheduler: Scheduling? = nil) {
    self.queue = queue
    self.environment = environment
    let scheduler = scheduler ?? QueueScheduler(queue: queue)
    self.scheduler = scheduler
    let clock = EpochClock(wallAtStartMs: Date().timeIntervalSince1970 * 1000, monotonicAtStart: scheduler.now)
    self.clock = clock
    scanController = ScanController(scheduler: scheduler, clock: clock)
    publishedState = Self.stateWithoutCentral(environment.authorization())
  }

  /// The latest state. Safe from any thread and never waits for `queue` (plan §4.7).
  var state: BleState {
    stateLock.lock()
    defer { stateLock.unlock() }
    return publishedState
  }

  /// Creates the manager when that can't show the permission prompt (the app is already
  /// authorized), so `state` reports the adapter. Called when JS first reads or observes the state.
  func activateIfAuthorized() {
    if central == nil, environment.authorization() == .allowedAlways, missingDeclaration() == nil {
      createCentral()
    }
  }

  /// Re-reads the authorization, which the user may have changed in Settings. Called when the app
  /// returns to the foreground.
  func refresh() {
    guard central == nil else { return }
    publish(Self.stateWithoutCentral(environment.authorization()))
    activateIfAuthorized()
  }

  /// Never shows the prompt.
  func permissions() throws -> BlePermissions {
    if let error = missingDeclaration() {
      throw error
    }
    return BlePermissions(authorization: environment.authorization())
  }

  /// On iOS, requesting means creating the manager, which shows the prompt once (plan §4.13).
  /// Completes when the user has answered. The request flags don't matter: one authorization
  /// covers every capability.
  func requestPermissions(_ completion: @escaping PermissionsCompletion) {
    if let error = missingDeclaration() {
      completion(.failure(error))
      return
    }
    let authorization = environment.authorization()
    guard authorization == .notDetermined else {
      activateIfAuthorized()
      completion(.success(BlePermissions(authorization: authorization)))
      return
    }
    pendingPermissionRequests.append(completion)
    if central == nil {
      createCentral()
    }
  }

  /// The manager, created if needed, when the app is authorized. Never shows the prompt.
  func authorizedCentral() throws -> CentralManaging {
    switch environment.authorization() {
    case .allowedAlways:
      break
    case .notDetermined:
      throw CoreError(
        .bluetoothUnauthorized,
        "Bluetooth permission hasn't been requested yet. Call requestPermissionsAsync() first."
      )
    default:
      throw CoreError(.bluetoothUnauthorized, "Bluetooth permission is denied. The user can allow it in Settings.")
    }
    if let central {
      return central
    }
    createCentral()
    guard let central else {
      throw CoreError(.internal, "The central manager could not be created")
    }
    return central
  }

  // MARK: CentralManagingDelegate

  func centralDidUpdateState(_ central: CentralManaging) {
    publish(BleState(central.state))
    if central.state == .poweredOn {
      scanController.poweredOn(central)
      runPendingConnects(.success(central))
    } else if let error = Self.adapterError(central.state) {
      scanController.stopAll(error)
      sessions.values.forEach { $0.forceDisconnected(error) }
      runPendingConnects(.failure(error))
    }
    // CoreBluetooth reports a state once the user has answered the prompt.
    let authorization = environment.authorization()
    guard authorization != .notDetermined, !pendingPermissionRequests.isEmpty else {
      return
    }
    let completions = pendingPermissionRequests
    pendingPermissionRequests.removeAll()
    let permissions = BlePermissions(authorization: authorization)
    completions.forEach { $0(.success(permissions)) }
  }

  // MARK: Private

  private func createCentral() {
    // No system "turn on Bluetooth" alert: the app sees `poweredOff` and decides what to show.
    let central = environment.makeCentral(queue, [CBCentralManagerOptionShowPowerAlertKey: false])
    // Callbacks arrive on `queue`, where this runs, so none can be missed.
    central.delegate = self
    self.central = central
  }

  private func publish(_ newState: BleState) {
    stateLock.lock()
    let changed = publishedState != newState
    publishedState = newState
    stateLock.unlock()
    if changed {
      onStateChange?(newState)
    }
  }

  /// Creating a manager without the usage description crashes the app (plan §4.3).
  func missingDeclaration() -> CoreError? {
    if let value = environment.infoDictionary()?[Self.usageDescriptionKey] as? String, !value.isEmpty {
      return nil
    }
    return CoreError(
      .misconfigured,
      "Info.plist has no \(Self.usageDescriptionKey), and using Bluetooth without it would crash the app. "
        + "Add the expo-ble-kit config plugin to your app config, or add the key by hand "
        + "(\(CoreError.setupGuide))."
    )
  }
}

// MARK: - Connections (P1-05)

extension CentralEngine {
  /// JS connection state of `peripheralId`. Safe from any thread and never waits for `queue`.
  func connectionState(_ peripheralId: String) -> String {
    stateLock.lock()
    defer { stateLock.unlock() }
    return connectionStates[peripheralId.uppercased()] ?? SessionState.disconnected.js
  }

  /// Connects to `peripheralId` (plan §5.4). Throws when connecting can't start: an invalid id, a
  /// missing declaration or authorization, or Bluetooth that is off. Never shows the prompt.
  /// `completion` gets nil once the connection is ready, or the error (PERIPHERAL_NOT_FOUND when iOS
  /// doesn't know the id).
  func connect(_ peripheralId: String, spec: ConnectSpec, completion: @escaping PeripheralSession.Completion) throws {
    if let error = missingDeclaration() {
      throw error
    }
    guard let identifier = UUID(uuidString: peripheralId) else {
      throw CoreError(.invalidArgument, "Not a peripheral id: \(peripheralId)")
    }
    try withCentral(for: identifier) { [weak self] result in
      switch result {
      case let .success(central):
        self?.startConnect(identifier, central: central, spec: spec, completion: completion)
      case let .failure(error):
        completion(error)
      }
    }
  }

  /// Runs `work` with the manager once it reports a real state: at once, or after `unknown`. Throws
  /// when the manager can't be used: a missing declaration, no authorization, or Bluetooth off.
  func withCentral(for id: UUID = UUID(), _ work: @escaping (Result<CentralManaging, CoreError>) -> Void) throws {
    if let error = missingDeclaration() {
      throw error
    }
    let central = try authorizedCentral()
    if let error = Self.adapterError(central.state) {
      throw error
    }
    if central.state == .unknown {
      pendingConnects.append((id, work))
    } else {
      work(.success(central))
    }
  }

  /// The discovery cache of `peripheralId` as JS `Service[]`. Safe from any thread.
  func services(_ peripheralId: String) -> [[String: Any]] {
    stateLock.lock()
    defer { stateLock.unlock() }
    return (discoveredServices[peripheralId.uppercased()] ?? []).map(\.dictionary)
  }

  /// ATT MTU of `peripheralId`; 23 when not connected. Safe from any thread.
  func mtu(_ peripheralId: String) -> Int {
    stateLock.lock()
    defer { stateLock.unlock() }
    return mtus[peripheralId.uppercased()] ?? PeripheralSession.defaultMtu
  }

  /// Discovers `filter` (all when nil) on a ready connection; DISCONNECTED otherwise.
  func discover(
    _ peripheralId: String,
    filter: [String]?,
    timeout: TimeInterval?,
    operationId: Int? = nil,
    completion: @escaping (Result<[[String: Any]], CoreError>) -> Void
  ) {
    guard let identifier = UUID(uuidString: peripheralId), let session = sessions[identifier] else {
      return completion(.failure(CoreError(.disconnected, "Not connected to \(peripheralId)")))
    }
    session.discover(filter, timeout: timeout, operationId: operationId) { result in
      completion(result.map { $0.map(\.dictionary) })
    }
  }

  /// The session of `peripheralId`, or nil after answering `completion` with DISCONNECTED.
  func session<T>(_ peripheralId: String, else completion: (Result<T, CoreError>) -> Void) -> PeripheralSession? {
    guard let identifier = UUID(uuidString: peripheralId), let session = sessions[identifier] else {
      completion(.failure(CoreError(.disconnected, "Not connected to \(peripheralId)")))
      return nil
    }
    return session
  }

  func disconnect(_ peripheralId: String, completion: @escaping () -> Void) {
    guard let identifier = UUID(uuidString: peripheralId) else {
      return completion()
    }
    let waiting = pendingConnects.filter { $0.id == identifier }
    pendingConnects.removeAll { $0.id == identifier }
    let cancelled = CoreError(.operationCancelled, "disconnect() cancelled the connection attempt")
    waiting.forEach { $0.run(.failure(cancelled)) }
    if let session = sessions[identifier] {
      session.disconnect(completion: completion)
    } else {
      completion()
    }
  }

  private func startConnect(
    _ identifier: UUID,
    central: CentralManaging,
    spec: ConnectSpec,
    completion: @escaping PeripheralSession.Completion
  ) {
    if let session = sessions[identifier] {
      return session.connect(spec, completion: completion)
    }
    // iOS knows peripherals it has seen (scans, earlier connections) by their per-app identifier.
    guard let peripheral = central.retrievePeripherals(withIdentifiers: [identifier]).first else {
      return completion(CoreError(
        .peripheralNotFound,
        "iOS doesn't know a peripheral with id \(identifier.uuidString). Scan for it first."
      ))
    }
    let session = PeripheralSession(peripheral: peripheral, central: central, scheduler: scheduler)
    session.onStateChange = { [weak self, weak session] state, error in
      self?.publishConnectionState(identifier.uuidString, state, error, mtu: session?.mtu)
    }
    session.onSubscriptionEnded = { [weak self] id, error in
      self?.onSubscriptionEnded?(identifier.uuidString, id, error)
    }
    session.onNameChange = { [weak self] name in
      self?.names[identifier.uuidString] = name
    }
    session.onMtuChange = { [weak self] mtu in
      guard let self else {
        return
      }
      stateLock.lock()
      mtus[identifier.uuidString] = mtu
      stateLock.unlock()
      onMtuChange?(identifier.uuidString, mtu)
    }
    wireNotifications(session, identifier)
    session.onServicesChange = { [weak self] services in
      guard let self else {
        return
      }
      stateLock.lock()
      discoveredServices[identifier.uuidString] = services
      stateLock.unlock()
    }
    sessions[identifier] = session
    session.connect(spec, completion: completion)
  }

  /// Notifications, batches (P2-04) and warnings of `session`, with epoch timestamps (plan §4.10).
  private func wireNotifications(_ session: PeripheralSession, _ identifier: UUID) {
    session.clock = { [weak self] in
      guard let self else {
        return 0
      }
      return clock.epochMs(monotonic: scheduler.now)
    }
    session.onNotification = { [weak self] characteristic, value, timestamp in
      self?.onNotification?(
        identifier.uuidString,
        characteristic.parentService?.uuid.fullUUIDString ?? "",
        characteristic.uuid.fullUUIDString,
        value,
        timestamp
      )
    }
    session.onNotificationBatch = { [weak self] subscriptionId, batch in
      self?.onNotificationBatch?(identifier.uuidString, subscriptionId, batch)
    }
    session.onWarning = { [weak self] warning in self?.onWarning?(warning) }
  }

  private func publishConnectionState(_ peripheralId: String, _ state: SessionState, _ error: CoreError?, mtu: Int?) {
    stateLock.lock()
    connectionStates[peripheralId] = state.js
    mtus[peripheralId] = mtu
    stateLock.unlock()
    onConnectionStateChange?(peripheralId, state, error)
  }

  private func runPendingConnects(_ result: Result<CentralManaging, CoreError>) {
    let pending = pendingConnects
    pendingConnects.removeAll()
    pending.forEach { $0.run(result) }
  }
}
