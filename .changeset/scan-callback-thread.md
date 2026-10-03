---
'expo-ble-kit': patch
---

Android: fixed a crash (`ConcurrentModificationException` in the scan controller) when many scan results arrived during a `reportIntervalMs` window. Scan results now reach the library's Bluetooth thread like every other callback.
