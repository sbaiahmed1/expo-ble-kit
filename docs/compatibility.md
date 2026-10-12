---
title: Compatibility
---

# Compatibility

## Versions

| expo-ble-kit | Expo SDK | React Native | iOS | Android | Web |
| --- | --- | --- | --- | --- | --- |
| 2.0.x | 57 | 0.86 | 16.4+ | 8.0 (API 26)+ | Chrome and Edge with Web Bluetooth (desktop and Android), over HTTPS or `localhost` |
| 0.1.x | 57 | 0.86 | 16.4+ | 8.0 (API 26)+ | none |

New Architecture only. It needs a development build, or a bare React Native app with `expo` installed: Expo Go doesn't include the native code. The iOS Simulator and the Android emulator's default radio have no usable Bluetooth: test on devices.

## What each platform supports

| Feature | iOS | Android | Web |
| --- | --- | --- | --- |
| Scan with filters, several scans at once | ✅ | ✅ (5 scan starts per 30 s; the library spaces them) | The browser's device chooser: one picked device per scan |
| Connect, discover, read, write, notify, indicate | ✅ | ✅ | ✅ (primary services named in the scan) |
| Reconnection policies | ✅ (and iOS 17+ system auto-reconnect) | ✅ | ❌ |
| MTU | read only (iOS negotiates) | `requestMtu` up to 517 | ❌ (20-byte writes without response) |
| RSSI of a connection | ✅ | ✅ | ❌ |
| `writeStream`, batched notifications | ✅ | ✅ | ✅ |
| Several connections | ✅ | ✅ (about 7; Android 8–9 connect one at a time) | ✅ |
| Bonding | implicit (encrypted reads prompt) | `createBond()` | ❌ |
| Connection priority, PHY | ❌ | ✅ (PHY: Bluetooth 5 on both sides) | ❌ |
| L2CAP channels | ✅ | ✅ Android 10 (API 29)+ | ❌ |
| GATT server, notifications | ✅ | ✅ | ❌ |
| Advertising | name and service UUIDs | service UUIDs, manufacturer and service data, the phone's own name; extended advertising with Bluetooth 5 | ❌ |
| Service change notifications | ✅ | ✅ Android 12+; `refreshGattCache()` before | ❌ |
| Connections in the background | `bluetooth-central` mode | foreground service (`keepAliveInBackground`) | ❌ |
| Relaunch after the system stopped the app | state restoration | background scans; companion presence (Android 12+) | ❌ |
| System device picker | AccessorySetupKit (iOS 18+) | CompanionDeviceManager | the chooser |

## Tested on hardware

What has run on real devices, with debug builds of the example app. Everything else is covered by unit tests of the native cores (Swift, Kotlin), the TypeScript tests and the test fake, which follow the same queue and error rules.

| Device | OS | What ran |
| --- | --- | --- |
| Samsung Galaxy A52 (SM-A525F) | Android 14 (API 34) | Permissions, scanning (several sessions, the scan-start throttle, a 45-minute scan), connection timeouts and cancellation, 100 connect/cancel cycles without a leaked GATT client, Bluetooth off and on 50 times with every operation settled, the keep-alive foreground service, a background scan waking the app after the system killed it, every example flow in demo mode |
| iPhone 14 Pro Max | iOS 27.0.1 | Scanning, connecting to a Mac, reads, RSSI, error paths; the GATT server with a Mac as the central (512-byte long reads, long writes, a 100 Hz stream without gaps, indications); advertising; L2CAP both ways (1 MB each way); the AccessorySetupKit picker; state restoration after a system termination (central and peripheral roles); force quit |
| Mac (macOS) | — | The test peripheral and central for the iPhone (`e2e/macos-peripheral`, `e2e/macos-central`) |
| Chrome 154 | macOS | The Explorer flow over Web Bluetooth with the iPhone serving the test profile: chooser, connect, discovery, a 512-byte read, a write, notifications (`e2e/web-chrome`) |

## Not checked on hardware yet

- Android against a test peripheral: reads, writes, notifications and throughput (`docs/benchmarks.md`), L2CAP, bonding, PHY, the two-phone suite, and companion device presence.
- The background scenarios on Android: an hour with the screen off and the foreground service, background scans on Android 10 or 11 (`docs/qa/background.md`).
- The rest of the device matrix: an iPhone on iOS 16, Android 8 to 11, a Pixel, and the manufacturers with aggressive battery policies (Xiaomi, OnePlus, Oppo).
- The soak runs that need a test board (`docs/soak.md`): an hour of notifications, 500 connect cycles, throughput against native code.

Results from your own devices are welcome as issues or pull requests to these pages.
