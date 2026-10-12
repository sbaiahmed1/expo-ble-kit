# Background scenarios

The scenarios of plan §8.4, per device. The example app's Background tab lists the scenarios of the platform it runs on, with their steps and controls. The test peripheral is this Mac running `e2e/macos-peripheral` (the test profile over CoreBluetooth), unless a row says otherwise.

## iPhone 14 Pro Max, iOS 27.0.1 (2026-10-12)

The example app in a debug build (Expo SDK 57, scene support on), with `ios.backgroundModes: ['central', 'peripheral']` and `ios.restoreIdentifier`.

| Scenario | Result | How |
|---|---|---|
| S-B1: app in the background while a 1 Hz stream continues | Pass. Two minutes in the background (Settings opened over the app): native code received the stream throughout, and the JS listener had 151 values and 0 gaps when the app came back. | Deep link `…://restoration/arm`, then `xcrun devicectl` launching Settings and the app again |
| S-B2: app terminated by the system, then the peripheral notifies | Pass. iOS relaunched the app about 5 s after the SIGKILL; the engine restored the connection with Heart Rate still notifying; a scene connected in the background and JS started; the background task received `connecting`, `connected`, `restored` and every notification in order (70 in a minute, no gap). | `e2e/ios-restoration/run.sh` |
| S-B2, peripheral role (P4-04) | Pass. While the app was stopped, iOS kept advertising and answered static reads; a dynamic read relaunched the app, which served the restored GATT server again: `e2e/macos-central` passed 11 of 11. | `e2e/ios-restoration/server.sh` |
| S-B6: the user force-quits the app | Pass. The connection ended at once (the peripheral saw the unsubscribe), iOS didn't relaunch the app, and the next manual launch restored nothing. | Argent: the app switcher, the app's card swiped away |

Still to run on iOS: S-B2 in a release build, where JS loads from the app instead of Metro.

## Android

| Scenario | Device | Result |
|---|---|---|
| S-B3: screen off for 60 minutes with the foreground service and a 10 Hz stream | Galaxy A52 (Android 14) | Not run yet |
| S-B4: process killed, then the peripheral advertises; the task gets `scanResults` | Galaxy A52; an Android 10 or 11 device | Background scan wake-up seen on the A52 (P3-04); against the test peripheral, and on Android 10 or 11, not run yet |
| S-B5: a companion device comes into range | Galaxy A52 (Android 14) | Implemented (P5-05); not run yet. Checks → Companion device: associate the test peripheral, register the presence task, kill the app, stop and restart `e2e/macos-peripheral` |
