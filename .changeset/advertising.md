---
'expo-ble-kit': minor
---

Advertising: `BleManager.startAdvertising(data, options)` advertises the phone as a peripheral on iOS and Android, one advertisement at a time, and resolves with an `Advertisement` to `stop()`. iOS advertises the local name and service UUIDs; Android also advertises manufacturer data, service data and the TX power level, with `android` options for the interval, transmit power, extended advertising and a timeout, but only the phone's own Bluetooth name. What a platform can't advertise is reported as a `NOT_SUPPORTED` warning. New config plugin options: `android.advertise` declares `BLUETOOTH_ADVERTISE`, and `ios.backgroundModes: ['peripheral']` adds the `bluetooth-peripheral` background mode. The testing entry gains `FakeBle.advertisement`.
