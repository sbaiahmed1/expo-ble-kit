---
'expo-ble-kit': minor
---

Android: `BleManager.registerBackgroundTask(taskName, { events: ['scanResults'], scan })` runs a background scan that delivers matching advertisements to an `expo-task-manager` task, waking the app even after Android stopped it; `unregisterBackgroundTask` stops it. On Android 10–11 it needs background location: the config plugin declares it with `android: { backgroundLocation: true }`. New types `BackgroundTaskOptions` and `BleBackgroundEvent`. On iOS, `registerBackgroundTask` rejects with `NOT_SUPPORTED` for now.
