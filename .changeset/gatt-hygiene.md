---
'expo-ble-kit': minor
---

Service changes: when a connected peripheral's services change (iOS, and Android 12+), the library discovers them again, keeps the subscriptions that are still possible, and calls `peripheral.addServicesChangedListener` listeners. `peripheral.android.refreshGattCache()` clears Android's GATT cache and discovers again (hidden API, resolves `false` where unavailable). The Android connect option `android.resetAfterTimeouts` sets how many operations in a row may time out before the connection is reset (default 2, `false` to never reset), and a reset now reconnects when a `reconnect` policy is set.
