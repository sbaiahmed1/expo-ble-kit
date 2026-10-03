---
'expo-ble-kit': minor
---

Android: `connect({ keepAliveInBackground: true })` keeps the app running in the background while the connection is open, with a foreground service of type `connectedDevice` that stops when the connection ends (reconnecting keeps it). Enable it with the config plugin option `android: { foregroundService: true }`; set its notification with `BleManager.android.setForegroundServiceNotification()`. A start Android refuses (the app was in the background) sends a `FOREGROUND_SERVICE_FAILED` warning. `getDiagnostics().android.foregroundService` tells whether it runs. On iOS the option still rejects with `NOT_SUPPORTED`.
