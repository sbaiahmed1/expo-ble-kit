import ExpoModulesCore

/// Creates the shared engine at launch when the app configures restoration (P3-01, plan §4.14):
/// iOS hands restored peripherals only to a manager created during launch. Registered in
/// expo-module.config.json; Expo forwards app delegate events to it under the scene life cycle too.
public class BleKitAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    BleKitRuntime.shared.didFinishLaunching(launchOptions, state: application.applicationState)
    return false
  }
}
