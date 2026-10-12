---
'expo-ble-kit': minor
---

Android companion devices: `BleManager.android.associateCompanionDevice(filter)` shows Android's companion device picker and resolves the picked device's `Peripheral` (or null), without the Bluetooth scan permission. Background tasks can now receive `devicePresence` on Android 12+: Android starts the app when an associated device comes into range or leaves it. Turn it on with the config plugin's `android.companionDevice` option (bare apps: see the bare-setup guide). `BleManager.android.isLocationServicesEnabled()` tells whether Location Services are on, which scans on Android 11 and older and the companion picker need.
