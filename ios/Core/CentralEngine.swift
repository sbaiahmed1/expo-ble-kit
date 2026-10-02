import CoreBluetooth
import Foundation

/// Owns the central manager (plan §4.3). This first part covers adapter state and permissions
/// (P1-03); scanning and peripheral sessions join in P1-04 and P1-05.
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

  private let environment: Environment
  private(set) var central: CentralManaging?
  private var pendingPermissionRequests: [PermissionsCompletion] = []

  private let stateLock = NSLock()
  private var publishedState: BleState

  init(queue: DispatchQueue, environment: Environment = .live) {
    self.queue = queue
    self.environment = environment
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

  // MARK: CentralManagingDelegate

  func centralDidUpdateState(_ central: CentralManaging) {
    publish(BleState(central.state))
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
