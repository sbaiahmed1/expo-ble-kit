import CoreBluetooth
import Foundation

/// Owns the central manager (plan §4.3): adapter state and permissions (P1-03) and scanning
/// (P1-04). Peripheral sessions join in P1-05.
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

  private let environment: Environment
  private(set) var central: CentralManaging?
  private var pendingPermissionRequests: [PermissionsCompletion] = []

  private let stateLock = NSLock()
  private var publishedState: BleState

  init(queue: DispatchQueue, environment: Environment = .live, scheduler: Scheduling? = nil) {
    self.queue = queue
    self.environment = environment
    let scheduler = scheduler ?? QueueScheduler(queue: queue)
    let clock = EpochClock(wallAtStartMs: Date().timeIntervalSince1970 * 1000, monotonicAtStart: scheduler.now)
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

  /// Starts a scan session (plan §5.3). Throws when scanning can't start: a missing declaration, no
  /// authorization, or Bluetooth that is off. Never shows the permission prompt. While the manager
  /// still reports `unknown`, the session waits for the first real state.
  func startScan(_ sessionId: Int, spec: ScanSpec) throws {
    if let error = missingDeclaration() {
      throw error
    }
    if scanController.activeSessionIds.contains(sessionId) {
      throw CoreError(.invalidArgument, "Scan session \(sessionId) is already running")
    }
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
    if central == nil {
      createCentral()
    }
    if let central, let error = Self.scanError(central.state) {
      throw error
    }
    scanController.start(sessionId, spec: spec)
  }

  func stopScan(_ sessionId: Int) {
    scanController.stop(sessionId)
  }

  /// Why scanning can't run in `state`; nil for `poweredOn` and for `unknown`, which resolves shortly.
  static func scanError(_ state: CBManagerState) -> CoreError? {
    switch state {
    case .poweredOn, .unknown:
      return nil
    case .resetting:
      return CoreError(.bluetoothResetting, "Bluetooth is resetting")
    case .unsupported:
      return CoreError(.bluetoothUnsupported, "This device doesn't support Bluetooth LE")
    case .unauthorized:
      return CoreError(.bluetoothUnauthorized, "Bluetooth permission is denied. The user can allow it in Settings.")
    case .poweredOff:
      return CoreError(.bluetoothPoweredOff, "Bluetooth is off")
    @unknown default:
      return CoreError(.internal, "Unknown Bluetooth state \(state.rawValue)")
    }
  }

  // MARK: CentralManagingDelegate

  func centralDidUpdateState(_ central: CentralManaging) {
    publish(BleState(central.state))
    if central.state == .poweredOn {
      scanController.poweredOn(central)
    } else if let error = Self.scanError(central.state) {
      scanController.stopAll(error)
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

  func central(
    _ central: CentralManaging,
    didDiscover peripheral: PeripheralLike,
    advertisementData: [String: Any],
    rssi: Int
  ) {
    scanController.deliver(peripheral, advertisementData: advertisementData, rssi: rssi)
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
  private func missingDeclaration() -> CoreError? {
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

  /// Before the manager exists, the authorization is all that can be read without the prompt.
  static func stateWithoutCentral(_ authorization: CBManagerAuthorization) -> BleState {
    authorization == .denied || authorization == .restricted ? .unauthorized : .unknown
  }
}
