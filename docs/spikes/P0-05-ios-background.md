# Spike P0-05: iOS background relaunch

**Question:** under Expo SDK 57 with the UIScene life cycle (`expo-build-properties` `ios.enableSceneSupport`, needed on iOS 27), what happens when iOS stops an app that uses CoreBluetooth state restoration and later relaunches it for Bluetooth? Does the app delegate subscriber run, does the JS runtime start, and can a TaskManager task receive the events?

**Setup (2026-10-12):** iPhone 14 Pro Max, iOS 27.0.1; the example app (debug build, Metro over Wi-Fi) with `ios.backgroundModes: ['central', 'peripheral']` and `ios.restoreIdentifier`; this Mac as the test peripheral (`e2e/macos-peripheral`), sending Heart Rate Measurement at 1 Hz. `e2e/ios-restoration/run.sh` connects the app, subscribes to heart rate, stops the app with SIGKILL through `xcrun devicectl` (as iOS does under memory pressure; the app switcher would tell iOS not to relaunch it) and reads the restoration journal the library keeps on the phone.

## Findings

1. **iOS relaunches the app.** About 5 s after the SIGKILL, with the Mac still notifying, iOS launched the app in the background. The library's app delegate subscriber ran (`didFinishLaunching`, Expo forwards it under the scene life cycle), created the central manager with the restore identifier, and `willRestoreState` handed back the connection: connected, with Heart Rate Measurement still notifying. Notifications kept arriving in the background (58 in the next minute). Every run that started from a fresh connection behaved this way.
2. **The launch options don't say why.** Under the scene life cycle the relaunch's launch options carried no `bluetoothCentrals` key. The library doesn't rely on it: it creates the manager at every launch when the app declares restoration and Bluetooth is already allowed.
3. **A scene connects in the background, so JS runs.** During the background relaunch UIKit connected a window scene (`scene(_:willConnectTo:)` with the app still in the background), and Expo's scene delegate started React Native: the library saw JS 2 to 8 s after the relaunch (8 s over Wi-Fi Metro in a debug build). So a background task defined at module scope runs.
4. **expo-task-manager has no headless loader in these builds.** `EXTaskService` asks `UMAppLoaderProvider` for a "react-native-experience" loader to start JS for a task; only Expo Go registers one. Without finding 3, events would wait in TaskManager's memory until the app's JS starts.
5. **expo-task-manager 57 can lose one event while JS starts listening.** `TaskManagerModule` copies its event queue and sets it to nil on the JS thread, while events are handed to it on the main thread: one heart rate value (75) went missing exactly when JS started. The library now holds background events until JS reached the library plus 1 s (or 15 s after launch for apps whose JS never does), then releases them in order. Run with the fix: 70 notifications delivered to the task in order, no gap.
6. **Values arrive as `Uint8Array`** in the task, like in the foreground.
7. **A restored pending connection may never complete.** After the app was killed by a reinstall while connected, iOS restored the peripheral as connecting, and that connection didn't complete while the Mac advertised nearby. A JS `connect()` now takes such a connection over with its own options and timeout and issues CoreBluetooth's connect again, which connected at once. In the one run of that path, iOS dropped the link at the next SIGKILL instead of preserving it.

## Decision (ADR-008)

Background events reach an `expo-task-manager` task through a consumer (`BackgroundTaskConsumer`, the iOS twin of Android's), backed by a native event buffer:

- The engine is created at launch by `BleKitAppDelegateSubscriber` when restoration is declared and Bluetooth is allowed; it lives for the process and outlives JS reloads.
- Restored peripherals are adopted once the manager is on: connected ones become ready with what CoreBluetooth kept, notifying characteristics keep delivering until a JS subscription takes them over, pending connections stay pending.
- The task gets `restored` when iOS hands back connections, and `connectionStateChange` and `notification` while the app isn't in the foreground. Delivery waits for JS (finding 5).
- A restoration journal (`getDiagnostics().ios.restoration.journal`, kept across launches) records launches, scenes, restored peripherals and background events, since none of it shows on screen.

Since run (`docs/qa/background.md`): S-B1 (a suspended app with a 1 Hz stream), S-B6 (force quit), and S-B2 in a release build, where JS loads from the app bundle instead of Metro: the relaunch, the restored connection and the background scene behave the same.
