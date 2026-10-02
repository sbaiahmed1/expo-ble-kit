# P0-04 — Binding spike (Expo Modules 1.0 DSL, SDK 57)

**Date:** 2026-10-02 · **Status:** Android measured on a real phone; **iOS real-device run pending** (needs code signing on the iPhone). Gate D1 is open.

## Question

Gate D1: which binding API do we build the library on, and therefore which minimum Expo SDK?

Under ADR-011 (stable releases only), Expo Modules 2.0 can't be evaluated yet: it is beta in SDK 58 and experimental (iOS only, undocumented) in SDK 57. This spike therefore answers a narrower question: **is the stable 1.0 DSL good enough to build P1 on?** That needs binary data handled correctly with no base64 (ADR-003), and enough call and event throughput for BLE workloads.

## Setup

- Expo SDK 57.0.26, React Native 0.86.3, Hermes, New Architecture, **release builds**.
- Code: throwaway branch `spike/p0-04-binding` (commit `0a70fd8`). The module was implemented with the 1.0 DSL on both platforms:
  - `noop()`, `readValue(size)` returning `Data` / `ByteArray`, `echo(value)` taking and returning bytes;
  - `emitScanResult(size)`: a module-level event whose payload holds a `Data` / `ByteArray` and a map of them (the shape of a scan result);
  - a `PeripheralObject` shared object with `readValue(size)` and `startBurst(count, size, rate)`, which emits `notification` events from a background queue/thread. Each payload is a record `{ seq, value, timestamp }`, and `value` is a STREAM frame from `test-peripherals/profile.json`.
- The benchmark screen (`example/App.tsx` on the branch) checks every byte it receives.
- **Measured device:** Samsung Galaxy A52 (SM-A525F), Snapdragon 720G, Android 14, connected over USB. Three consecutive runs after a fresh install; each figure inside a run is the median of 3 repetitions.
- Simulator and emulator runs were used only to check the wiring (correctness results below). Their timings are not used, by decision of the maintainer.

## Results — Galaxy A52, Android 14

| Benchmark | Run 1 (cold) | Run 2 | Run 3 |
|---|---|---|---|
| 10k async `noop()`, sequential | 4,459 ms (446 µs/call) | 2,340 ms (234 µs/call) | 1,148 ms (115 µs/call) |
| 10k async `noop()`, concurrent | 1,145 ms (115 µs/call) | 1,649 ms (165 µs/call) | 1,021 ms (102 µs/call) |
| 10k `readValue(20 B)`, sequential | 6,732 ms | 4,909 ms | 1,955 ms |
| 10k `PeripheralObject.readValue(20 B)` | 5,632 ms | 4,290 ms | 3,353 ms |
| `echo` 0 B … 1 MB | all OK, ≤ 5.0 ms | all OK, ≤ 9.2 ms | all OK, ≤ 6.2 ms |
| 10k events × 20 B paced at 10k/s | 1,007 ms, 0 lost | 1,002 ms, 0 lost | 1,002 ms, 0 lost |
| 10k events × 244 B paced at 10k/s | **2,099 ms (4,765/s)**, 0 lost | 1,010 ms, 0 lost | 1,010 ms, 0 lost |
| 10k events × 20 B unpaced | 645 ms (15,506/s) | 599 ms (16,690/s) | 539 ms (18,559/s) |

No event was lost, reordered or corrupted in any run. The phone warms up a lot: the first run after install is 2–4× slower than the third.

## Correctness (all runs, both platforms)

| Path | iOS (simulator) | Android (A52 and emulator) |
|---|---|---|
| Return value `Data` / `ByteArray` | `Uint8Array`, bytes exact | `Uint8Array`, bytes exact |
| Argument `Uint8Array` → `Data` / `ByteArray` → back, 0 B to 1 MB | exact | exact |
| Module event payload with nested binary fields | `Uint8Array` | `Uint8Array` |
| Shared-object event record with a binary field | `Uint8Array`, 0 lost, in order | `Uint8Array`, 0 lost, in order |

**There is no base64 anywhere.** Binary data is a real `Uint8Array` in every direction the library needs, including inside event payloads. Expo's docs only promise this for arguments and return values; the spike shows it holds for events too.

## What it means for BLE

The radio sets the pace, not the binding:

- **GATT operations:** each read or write takes at least one connection interval (7.5 ms at best, usually 15–50 ms). The binding adds 0.1–0.45 ms per call, under 6% even on a cold mid-range phone.
- **Notifications:** one connection at its best (LE 2M PHY, 244-byte packets, 7.5 ms interval) delivers on the order of 700 notifications/s; small 20-byte packets top out around 1,000–1,500/s. ⚠️ Estimates; P2-08 measures the real figures. On the A52 the binding absorbed 4,800–10,000 events/s of 244 B and 15,500–18,500/s of 20 B, so it has at least 6× headroom for one connection at full speed.
- **Several devices at full speed** (P2-05: 5+ connections) could approach the cold-phone limit for large packets. Native batching (ADR-007, P2-04) covers that case and should stay in the plan; it also feeds question Q2.

## Recommendation for D1 (maintainer decides)

**Start P1 on the stable 1.0 DSL with Expo SDK 57 as the minimum**, and migrate to Expo Modules 2.0, one member at a time, once SDK 58 is stable and documented.

- The 1.0 DSL meets every requirement this spike tested: binary-first data with no base64, events without loss or reordering, and throughput well above what the radio can produce.
- The binding is a thin layer by design (ADR-005), and 1.0 and 2.0 can coexist in one module, so a later migration touches only the binding layer.
- Waiting for SDK 58 stable would block P1 on someone else's schedule for a speed-up the radio would hide anyway.

If chosen, ADR-002 changes from "minimum SDK 58" to "minimum SDK 57", and the getting-started docs must tell SDK 57 apps built with Xcode 27 to enable `ios.enableSceneSupport` (see P0-03).

## Still open

- **iOS on a real iPhone:** same app, release build. It needs a development team for signing.
- A low-end Android phone would show the worst case; the A52 is mid-range.
- Real BLE throughput through the binding is measured in P2 (P2-04, P2-08), not here.
