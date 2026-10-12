import CoreBluetooth
import UIKit

/// The process-wide part of the binding (P3-01, plan §4.14). With restoration configured, the
/// engine exists before JS does: `BleKitAppDelegateSubscriber` creates it at launch, so iOS can hand
/// back the peripherals it kept for the app, and it outlives JS reloads. The module then uses it
/// instead of an engine of its own. The journal records what happened around background relaunches.
final class BleKitRuntime {
  static let shared = BleKitRuntime()

  let journal = RestorationJournal(url: RestorationJournal.defaultURL)
  /// The app declares a restore identifier and the bluetooth-central background mode.
  let restorationEnabled = CentralEngine.restoreIdentifier(in: Bundle.main.infoDictionary) != nil
  /// P4-04: the peripheral role's restore identifier, when the app also declares bluetooth-peripheral.
  let peripheralRestoreIdentifier: String? = {
    let info = Bundle.main.infoDictionary
    let modes = info?["UIBackgroundModes"] as? [String] ?? []
    guard modes.contains("bluetooth-peripheral"), let identifier = CentralEngine.restoreIdentifier(in: info) else {
      return nil
    }
    return identifier + ".peripheral"
  }()
  /// The peripheral role's queue (plan §4.7), shared by every module instance.
  let peripheralQueue = DispatchQueue(label: "expo.blekit.peripheral")
  private var peripheralManager: CBPeripheralManagerAdapter?

  private let lock = NSLock()
  private var engine: CentralEngine?
  /// Whether the app is in the foreground; notifications are only journaled while it isn't.
  private var active = false
  private var observing = false
  /// The TaskManager consumers of `registerBackgroundTask` (P3-02).
  private var consumers: [BackgroundTaskConsumer] = []
  /// `restored` events from before TaskManager re-created its consumers at launch.
  private var pendingRestored: [[String: Any]] = []
  /// Background events wait here until JS had time to listen (expo-task-manager 57 race).
  private lazy var events = BackgroundEventQueue(scheduler: QueueScheduler(queue: .main)) { [weak self] in
    self?.handOver($0)
  }

  /// The engine shared by every module instance; only with restoration.
  func sharedEngine() -> CentralEngine {
    lock.lock()
    defer { lock.unlock() }
    if let engine {
      return engine
    }
    let created = CentralEngine(queue: DispatchQueue(label: "expo.blekit.central"))
    created.logger.platform = BleLogger.osLog
    engine = created
    decorate(created)
    return created
  }

  /// With peripheral restoration, the one peripheral manager of the process (P4-04); on the
  /// peripheral queue.
  func sharedPeripheralManager() -> CBPeripheralManagerAdapter {
    if let peripheralManager {
      return peripheralManager
    }
    let manager = CBPeripheralManagerAdapter(queue: peripheralQueue, restoreIdentifier: peripheralRestoreIdentifier)
    manager.onRestore = { [journal] services, advertisement in
      let names = services.map(\.uuidString).joined(separator: ", ")
      let advertising = advertisement.map { " and advertising \(Self.describe($0))" } ?? ""
      journal.record("restored the GATT server: \(services.count) service(s) (\(names))\(advertising)")
    }
    peripheralManager = manager
    return manager
  }

  /// At launch: iOS hands restored peripherals only to a manager created during launch with the
  /// same restore identifier (plan §4.14). Creating it can't show the prompt: only authorized apps
  /// get it this early.
  func didFinishLaunching(_ options: [UIApplication.LaunchOptionsKey: Any]?, state: UIApplication.State) {
    guard restorationEnabled else {
      return
    }
    observeLifecycle(state)
    events.launched()
    let centrals = options?[.bluetoothCentrals] as? [String] ?? []
    let reason = centrals.isEmpty ? "" : ", by iOS for Bluetooth (\(centrals.joined(separator: ", ")))"
    journal.record("launched \(Self.name(state))\(reason)")
    let engine = sharedEngine()
    engine.queue.sync { engine.activateIfAuthorized() }
    // P4-04: the peripheral manager too, when that can't show the prompt either.
    if peripheralRestoreIdentifier != nil, CBManager.authorization == .allowedAlways {
      peripheralQueue.sync { _ = sharedPeripheralManager() }
    }
  }

  /// The module set the engine's callbacks: JS runs.
  func attached(_ engine: CentralEngine) {
    guard restorationEnabled else {
      return
    }
    journal.record("JS started")
    events.jsStarted()
    decorate(engine)
  }

  func add(_ consumer: BackgroundTaskConsumer) {
    lock.lock()
    consumers.append(consumer)
    let pending = pendingRestored
    pendingRestored.removeAll()
    lock.unlock()
    DispatchQueue.main.async { pending.forEach(consumer.deliver) }
  }

  func remove(_ consumer: BackgroundTaskConsumer) {
    lock.lock()
    consumers.removeAll { $0 === consumer }
    lock.unlock()
  }

  /// Queues a JS `BleBackgroundEvent` for the background tasks.
  private func deliver(_ event: [String: Any]) {
    events.submit(event)
  }

  /// Hands a released event to the tasks, on the main queue. A `restored` event waits for a task
  /// when TaskManager hasn't re-created them yet.
  private func handOver(_ event: [String: Any]) {
    lock.lock()
    let receivers = consumers
    if receivers.isEmpty, event["type"] as? String == "restored" {
      pendingRestored.append(event)
    }
    lock.unlock()
    receivers.forEach { $0.deliver(event) }
  }

  /// `getDiagnostics().ios.restoration`.
  var diagnostics: [String: Any] {
    [
      "enabled": restorationEnabled,
      "journal": journal.all.map { ["time": $0.time, "event": $0.event, "count": $0.count] as [String: Any] }
    ]
  }

  // MARK: Private

  /// Journals what the engine reports, then calls what the module set.
  private func decorate(_ engine: CentralEngine) {
    let journal = journal
    let restored = engine.onRestored
    engine.onRestored = { [unowned self] peripherals in
      for peripheral in peripherals {
        let notifying = peripheral.subscriptions.joined(separator: ", ")
        let detail = notifying.isEmpty ? "" : ", notifying: \(notifying)"
        journal.record("restored \(peripheral.id): \(peripheral.state)\(detail)")
      }
      self.deliver(["type": "restored", "peripheralIds": peripherals.map(\.id)])
      restored?(peripherals)
    }
    let stateChange = engine.onConnectionStateChange
    engine.onConnectionStateChange = { [weak self] id, state, error in
      if self?.isActive == false {
        journal.record("\(id) \(state.js)" + (error.map { ": \($0.code.rawValue)" } ?? "") + " (in the background)")
        self?.deliver(["type": "connectionStateChange", "peripheralId": id, "state": state.js])
      }
      stateChange?(id, state, error)
    }
    let notification = engine.onNotification
    engine.onNotification = { [weak self] id, service, characteristic, value, timestamp in
      if self?.isActive == false {
        self?.deliver([
          "type": "notification", "peripheralId": id, "service": service, "characteristic": characteristic,
          "value": value, "timestamp": timestamp
        ])
        let bytes = value.prefix(8).map { String(format: "%02x", $0) }.joined(separator: " ")
        journal.record(
          "notification from \(id) \(characteristic): \(bytes) (in the background)",
          repeating: "\(id)/\(characteristic)"
        )
      }
      notification?(id, service, characteristic, value, timestamp)
    }
  }

  private var isActive: Bool {
    lock.lock()
    defer { lock.unlock() }
    return active
  }

  private func setActive(_ value: Bool) {
    lock.lock()
    active = value
    lock.unlock()
  }

  private func observeLifecycle(_ state: UIApplication.State) {
    guard !observing else {
      return
    }
    observing = true
    setActive(state == .active)
    let center = NotificationCenter.default
    center.addObserver(forName: UIScene.willConnectNotification, object: nil, queue: .main) { [weak self] _ in
      self?.journal.record("a window scene connected (\(Self.name(UIApplication.shared.applicationState)))")
    }
    let observe = { (name: Notification.Name, handle: @escaping (BleKitRuntime) -> Void) in
      center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        self.map(handle)
      }
    }
    observe(UIApplication.didBecomeActiveNotification) { $0.setActive(true) }
    observe(UIApplication.didEnterBackgroundNotification) {
      $0.setActive(false)
      $0.journal.record("entered the background")
    }
    observe(UIApplication.willEnterForegroundNotification) { $0.journal.record("entering the foreground") }
  }

  private static func describe(_ advertisement: [String: Any]) -> String {
    let name = advertisement[CBAdvertisementDataLocalNameKey] as? String
    let services = (advertisement[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? []).map(\.uuidString)
    return ([name].compactMap { $0 } + services).joined(separator: ", ")
  }

  private static func name(_ state: UIApplication.State) -> String {
    switch state {
    case .active: return "in the foreground"
    case .inactive: return "inactive"
    case .background: return "in the background"
    @unknown default: return "in an unknown state"
    }
  }
}
