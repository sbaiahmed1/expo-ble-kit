---
title: Soak tests
---

# Soak tests

The long runs expo-ble-kit must pass on every phone in the test matrix before a release (plan §8.5 and §8.2). They catch what unit tests can't: leaks, stuck operations, and phones that behave differently after an hour.

| Run | Pass when | How |
|---|---|---|
| Notifications, 60 min | 100 Hz × 20 B, batched: no crash, no sequence gap, nothing dropped, memory growth under 10 % | `soak-notifications.yaml`, with `e2e/soak/meminfo.sh` on Android |
| Connect cycles | 500 connect/disconnect cycles: at least 99 % connect, no GATT client left open, no zombie session | `gatt-hygiene.yaml` |
| Bluetooth toggles | Bluetooth off and on 50 times during active operations: every operation settles with a coded error, no crash | `e2e/soak/bluetooth-toggle.sh` (Android) |
| Long scan | A filtered scan running 45 min with the screen on gets results every minute (Android) | `long-scan.yaml` |
| Throughput | `writeStream` and notifications at least 80 % of the native reference apps | [Benchmarks](benchmarks.md) |

Every run except the toggles needs the test peripheral (`test-peripherals/profile.json`: Bumble on a USB dongle, or the nRF52840) and a debug or release build of the example app. The checks are in the app's **Dev checks** tab: the 60-minute stream and the connect cycles in **Test peripheral**, the toggles and the long scan in **Soak**. The flows are in `e2e/maestro/`.

## Notifications for 60 minutes

The test peripheral streams 20-byte frames at 100 Hz (`CONTROL` `SET_STREAM`) to `subscribeBatched` with `intervalMs: 16`. Frames carry a sequence number, so the app counts gaps; `dropped` counts what the batcher had to drop.

```bash
e2e/soak/meminfo.sh -m 65 &          # Android: PSS once a minute
maestro test e2e/maestro/soak-notifications.yaml
```

`meminfo.sh` writes a CSV and compares the app's PSS at minute 5 (after warm-up) with the last sample. It also fails if the app's process changes, which means it crashed. On iOS, read the memory gauge in Xcode's Debug navigator at minute 5 and at the end.

## Connect cycles

The app connects to the test peripheral and disconnects 500 times, then reads `getDiagnostics()`: on Android, `openGattClients` must be 0, and no session may be left in a state other than `disconnected` or with operations queued (a zombie session).

```bash
maestro test e2e/maestro/gatt-hygiene.yaml
```

## Bluetooth toggles

The in-app check keeps operations running while Bluetooth goes off and on:

- a scan filtered on the test service, started again each time Bluetooth is back;
- connects to a device that isn't there (20 s timeout), which stay pending until Bluetooth goes off;
- with a test peripheral nearby: connect, subscribe, then reads, writes and 8 KiB streams until each drop.

It counts how every operation settles. The run passes when every rejection carries an error code, every operation pending when Bluetooth went off settles within 5 seconds, nothing is still pending 25 seconds after the end, the app saw every off, and the app didn't crash.

On Android, the script toggles Bluetooth from the Mac over adb (`svc bluetooth`), starts and stops the in-app check with Maestro, checks for a crash (same process, nothing in the crash log) and prints the app's memory before and after. Bluetooth is always back on when it exits.

```bash
e2e/soak/bluetooth-toggle.sh                 # 50 toggles: 3 s off, 6 s on
e2e/soak/bluetooth-toggle.sh -n 10 -s SERIAL # fewer toggles, a given phone
```

Samsung phones with "Bluetooth scanning" on (location settings) report `BLE_ON` instead of `OFF`; apps see that as off, and so does the script.

On iOS, nothing can turn Bluetooth off from the Mac. Tap **Bluetooth toggle soak: start**, turn Bluetooth off and on in Settings 50 times, then tap **stop and report**. The report must show 50 offs. ⚠️ VERIFY whether the Control Center button also counts: it disconnects accessories, but may leave Bluetooth on for apps.

Demo mode runs the same check against the fake adapter, which it turns off and on itself:

```bash
maestro test -e DEMO=true e2e/maestro/soak-toggle.yaml
```

## Long scan

Android quietly downgrades a scan that runs for about 30 minutes, so expo-ble-kit restarts long scans after 25 minutes (plan §4.4). This run checks that results keep coming: a filtered scan reports every advertisement (`allowDuplicates`) for 45 minutes, and every minute must have results. The app keeps the screen on while it runs.

```bash
maestro test e2e/maestro/long-scan.yaml                   # filtered on the test service
maestro test -e FILTER=apple e2e/maestro/long-scan.yaml   # filtered on Apple manufacturer data
```

The Apple filter needs no test peripheral: iPhones, Macs and AirPods nearby advertise Apple data all the time.

## Matrix and results

The phones of plan §8.2: iOS 16 (the floor) and the current iOS; Android 8–11 on any phone, Android 12–13 on a Pixel and a Samsung, Android 14–16 on a Pixel, a Samsung, a Xiaomi or Redmi, and a OnePlus or Oppo. Record each run with its date, the build (debug or release) and the peripheral.

| Phone | OS | Notifications 60 min | Connect cycles | Bluetooth toggles | Long scan | Throughput |
|---|---|---|---|---|---|---|
| Samsung Galaxy A52 (SM-A525F) | Android 14 | — | — | Pass without a peripheral, 2026-10-03, debug build: 50 offs, 106 ops, all coded, 0 late, 0 unsettled, no crash | Pass, 2026-10-03, debug build, Apple data filter: 45 / 45 min, 171–300 results per minute (after a fix for a crash this run found) | — |
| Pixel | Android 14–16 | — | — | — | — | — |
| Xiaomi or Redmi | Android 14–16 | — | — | — | — | — |
| OnePlus or Oppo | Android 14–16 | — | — | — | — | — |
| Pixel | Android 12–13 | — | — | — | — | — |
| Samsung | Android 12–13 | — | — | — | — | — |
| Any | Android 8–11 | — | — | — | — | — |
| iPhone | iOS 16 | — | — | — | — | — |
| iPhone | current iOS | — | — | — | — | — |
