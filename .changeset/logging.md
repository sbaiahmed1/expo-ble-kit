---
'expo-ble-kit': minor
---

Logging: `BleManager.setLogLevel(level)` and `BleManager.setLogHandler(handler)`. At `debug`, every GATT operation logs its id, kind, status and duration; `info` adds connection states and scans, `verbose` notifications. Logs go to Logcat (tag `BleKit`) and the iOS unified log (subsystem `expo.blekit`), and to the handler while one is set. A failed fire-and-forget `subscription.remove()` is logged as a warning.
