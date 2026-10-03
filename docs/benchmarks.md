---
title: Benchmarks
---

# Benchmarks

How fast expo-ble-kit moves data, compared with apps that use the platform Bluetooth API directly. The target (plan §8.5) is at least **80 % of the native reference** for `writeStream` and for notifications, on the same phone with the same peripheral.

## What is measured

Both sides run the same transfers against the test peripheral (`test-peripherals/profile.json`) and print one line per transfer in the same format:

```
writeWithoutResponse: 1048576 B in 9.12 s = 112.3 KB/s (244-byte packets, peripheral counted 1048576)
```

| Transfer | What happens | Timed from → to |
|---|---|---|
| `writeWithoutResponse` | 1 MiB to `SINK_NO_RSP` in packets of MTU − 3. expo-ble-kit: one `writeStream`. Reference: a loop that waits for the stack (Android `onCharacteristicWrite`, iOS `canSendWriteWithoutResponse`). The peripheral's `SINK_COUNTER` confirms every byte arrived. | first write → last write taken by the phone's stack |
| `writeWithResponse` | 256 KiB to `ECHO_WRITE`, one packet per write, each acknowledged. expo-ble-kit: `writeStream({ withResponse: true })`. | first write → last acknowledgement |
| `notifications` | `STREAM` at 1000 Hz with frames of MTU − 3 bytes (512 at most) for 10 s. expo-ble-kit: `subscribeBatched` with `intervalMs: 16`. The frame sequence numbers count gaps. | stream start command → 10 s later |
| `notificationsUnbatched` | The same through `subscribe` (one JS event per value). expo-ble-kit only, for comparison: it shows what batching saves. | as above |

The peripheral's own limits set the ceiling: the connection interval, the PHY and the MTU it accepts. Both sides use the defaults: Android asks for MTU 517, iOS negotiates by itself, and neither changes the connection interval or the PHY.

## Running

Use **release builds** on both sides: a debug build of the example runs JavaScript in development mode and is slower. Keep the phone and the peripheral in the same place for every run, run each side three times, and record the median.

**expo-ble-kit** (the example app's Throughput tab):

```bash
cd example
npx expo run:android --variant release
```

On iOS, `npx expo run:ios --configuration Release --device`. Open the **Throughput** tab and tap **Run the benchmarks**. The results stay on screen (the text can be selected and copied).

**Android reference** (`benchmarks/android-reference`, Kotlin and `android.bluetooth` only):

```bash
cd benchmarks/android-reference
./gradlew :app:installRelease
```

Open **BleKit Reference**, tap **Run benchmarks**, and read the results on screen or with `adb logcat -s BleKitRef` (one `RESULT` line per transfer). `ANDROID_HOME` must point at the Android SDK.

**iOS reference** (`benchmarks/ios-reference`, SwiftUI and CoreBluetooth only): open `BleKitReference.xcodeproj` in Xcode, choose your team under Signing, set the Run action of the scheme to Release, and run it on the iPhone. Tap **Run benchmarks**; the results show on screen and in Console (subsystem `expo.blekit.reference`).

## Results

Ratio = expo-ble-kit ÷ reference; the target is 80 % or more. Not measured yet: the runs need a test peripheral (an nRF52840 board or Bumble on a USB dongle) and, for iOS, an iPhone.

| Phone | OS | Peripheral | MTU | Transfer | Reference | expo-ble-kit | Ratio |
|---|---|---|---|---|---|---|---|
| Galaxy A52 (SM-A525F) | Android 14 | — | — | writeWithoutResponse | — | — | — |
| Galaxy A52 (SM-A525F) | Android 14 | — | — | writeWithResponse | — | — | — |
| Galaxy A52 (SM-A525F) | Android 14 | — | — | notifications | — | — | — |
| iPhone 14 Pro Max | iOS | — | — | writeWithoutResponse | — | — | — |
| iPhone 14 Pro Max | iOS | — | — | writeWithResponse | — | — | — |
| iPhone 14 Pro Max | iOS | — | — | notifications | — | — | — |

`notificationsUnbatched` goes in the notes of each run rather than the table: it has no reference counterpart.
