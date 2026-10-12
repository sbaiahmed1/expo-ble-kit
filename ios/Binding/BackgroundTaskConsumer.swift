import ExpoModulesCore

/// The TaskManager consumer of `registerBackgroundTask` on iOS (P3-02, plan §4.14). TaskManager
/// creates it when JS registers the task and again at each launch from its saved tasks, before JS
/// runs; it then receives the events the task asked for while the app isn't in the foreground,
/// through `BleKitRuntime`. TaskManager hands each event to the JS task, or keeps it until JS runs:
/// a background relaunch starts no JS in a development or production build (spike P0-05).
@objc(BleKitBackgroundTaskConsumer)
public final class BackgroundTaskConsumer: NSObject, EXTaskConsumerInterface {
  public var task: EXTaskInterface?

  /// The events the task asked for.
  var events: Set<String> {
    Set(task?.options?["events"] as? [String] ?? [])
  }

  public func taskType() -> String {
    "expo-ble-kit.events"
  }

  public static func supportsLaunchReason(_ launchReason: EXTaskLaunchReason) -> Bool {
    launchReason == EXTaskLaunchReasonBluetoothCentrals
  }

  public static func taskConsumerVersion() -> UInt {
    1
  }

  public func didRegisterTask(_ task: EXTaskInterface) {
    self.task = task
    BleKitRuntime.shared.add(self)
  }

  public func setOptions(_ options: [AnyHashable: Any]) {
    task?.options = options as? [String: Any]
  }

  public func didUnregister() {
    BleKitRuntime.shared.remove(self)
    task = nil
  }

  /// Hands `event` (a JS `BleBackgroundEvent`) to the task when it asked for its type.
  func deliver(_ event: [String: Any]) {
    guard let type = event["type"] as? String, events.contains(type) else {
      return
    }
    task?.execute(withData: event, withError: nil)
  }
}
