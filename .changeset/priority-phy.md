---
'expo-ble-kit': minor
---

Android: `peripheral.android.requestConnectionPriority('balanced' | 'high' | 'lowPower')` asks for a connection interval, and `peripheral.android.setPreferredPhy(tx, rx, codedOption)` asks for the 1M, 2M or coded PHY and resolves the PHYs the link uses. Both are queued with the GATT operations; on iOS, which chooses by itself, they reject with `NOT_SUPPORTED`. When Android doesn't report a PHY update (it may not when nothing changes), the library reads the PHYs instead of waiting for the timeout.
