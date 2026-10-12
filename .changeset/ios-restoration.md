---
'expo-ble-kit': minor
---

iOS background: with the config plugin's new `ios.backgroundModes: ['central']`, iOS keeps the app's connections, scans and notifications going in the background, and `connect({ keepAliveInBackground: true })` works on iOS (it needs that mode). With `ios.restoreIdentifier` as well, CoreBluetooth state restoration is on: when iOS stops the app, it keeps its connections and relaunches it in the background for their events, and the library hands them back at launch (connected ones `connected` with their notifications still on, pending ones `connecting`). `registerBackgroundTask` now works on iOS with the `restored`, `notification` and `connectionStateChange` events, delivered to an `expo-task-manager` task in order (measured on iOS 27: after a system termination the relaunched app's task received every notification). `getDiagnostics().ios.restoration.journal` records what happened around background relaunches, kept across launches.
