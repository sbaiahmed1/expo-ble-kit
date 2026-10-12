---
title: Background
---

# Background

What keeps working when the person leaves your app, what wakes it up again, and what the App Store and Google Play ask of apps that do it. The API is in [Getting started](../getting-started.md#staying-connected-in-the-background); this guide is about choosing, configuring and shipping it.

## What runs in the background

| You need | iOS | Android |
| --- | --- | --- |
| A connection that stays open while the app is in the background | `ios.backgroundModes: ['central']` | `connect({ keepAliveInBackground: true })` with `android.foregroundService` (a foreground service and its notification) |
| Notifications from that connection | the same | the same |
| The app started again after the system stopped it | state restoration: `ios.restoreIdentifier` (relaunched for its connections' events) | a background scan (`scanResults`) or a companion device (`devicePresence`) task |
| The app woken when a device comes near | a pending `connect({ timeoutMs: null })` with restoration | a background scan, or a companion device on Android 12+ |
| The phone acting as a device in the background | `ios.backgroundModes: ['peripheral']` | as in the foreground (a foreground service keeps the process alive) |
| After the person closes the app from the app switcher (iOS) or force-stops it (Android) | nothing: iOS doesn't relaunch it | nothing: a force stop cancels background scans until the app runs again |

Everything that runs while the app isn't on screen reaches JavaScript through an [`expo-task-manager`](https://docs.expo.dev/versions/latest/sdk/task-manager/) task defined at module scope (see [Getting started](../getting-started.md#scanning-in-the-background-android)). Connections already open keep calling your listeners while the JavaScript runtime is alive.

## iOS

### The `bluetooth-central` mode

```json
["expo-ble-kit", { "ios": { "backgroundModes": ["central"] } }]
```

With it, iOS keeps the app's connections open and delivers their notifications while the app is in the background, waking it briefly for each event. Without it, connections drop soon after the app leaves the screen.

- Scans keep running with a `services` filter only, report each device once (`allowDuplicates` is ignored), and slow down. A scan without filters finds nothing in the background.
- A pending `connect({ timeoutMs: null })` stays pending in the background and completes when the device comes into range, even hours later.
- iOS may still stop the app to free memory. Add state restoration so it comes back.

### State restoration

```json
["expo-ble-kit", { "ios": { "backgroundModes": ["central"], "restoreIdentifier": "com.example.sensor" } }]
```

When iOS stops the app, it keeps the connections (and pending connects) and relaunches the app in the background for their next event. The library takes them back at launch, before any screen exists: connected peripherals are `connected` with their notifications on, and your task receives `restored`, then `notification` and `connectionStateChange` events in order. Measured on an iPhone 14 Pro Max (iOS 27): relaunch about 5 seconds after the app was stopped, and every notification of the next minute delivered without a gap.

- The person closing the app from the app switcher ends everything, and iOS doesn't relaunch it. Tell your users, if your app depends on background delivery.
- Don't test restoration by closing the app from the app switcher: that's the case where it doesn't happen. `e2e/ios-restoration/kill.sh` in this repository stops the app the way the system does.
- `getDiagnostics().ios.restoration.journal` keeps what happened around relaunches across launches, because none of it shows on screen.

### The `bluetooth-peripheral` mode

```json
["expo-ble-kit", { "ios": { "backgroundModes": ["peripheral"] } }]
```

The GATT server keeps serving and advertising in the background. iOS then advertises without the local name, and moves service UUIDs to an overflow area that only other iOS devices scanning for them see. With a restore identifier too, iOS keeps the server's services and advertisement while the app is stopped, answers fixed values itself, and relaunches the app for the others.

### App Store review

App Review checks that background modes serve the app's purpose. Guideline 2.5.4: "Multitasking apps may only use background services for their intended purposes".

- Declare only the modes the app uses. A `bluetooth-peripheral` mode in an app that never advertises is a common reason for questions.
- In App Store Connect's review notes, say which feature uses each mode and why it must run in the background (for example: "Records heart rate from a chest strap during workouts while the screen is off").
- Reviewers don't have your device. Give them a way to see the feature: a short video of it working with the app in the background, or a demo mode that simulates the device (the example app's virtual test peripheral is one way to build it).
- The Bluetooth purpose string (`bluetoothAlwaysPermission` in the plugin options, `NSBluetoothAlwaysUsageDescription`) must say what the app does with Bluetooth, guideline 5.1.1(ii): "Ensure your purpose strings clearly and completely describe your use of the data." The default text is generic: write your own.

## Android

### The foreground service

```json
["expo-ble-kit", { "android": { "foregroundService": true } }]
```

`connect({ keepAliveInBackground: true })` runs a foreground service of type `connectedDevice`, with a notification, while the connection is open. It's the most dependable way to stay connected on Android: without it, Android may stop a background app at any time.

- Connect while the app is on screen: Android 12 and later refuse to start the service from the background, and the connection then goes on without it (a `FOREGROUND_SERVICE_FAILED` warning in the log).
- On Android 13 and later, ask for `POST_NOTIFICATIONS` so the notification shows; the service runs either way.
- `BleManager.android.setForegroundServiceNotification({ title, text })` sets what the notification says.

### Background scans and companion devices

- A background scan (`registerBackgroundTask` with `scanResults`) keeps running in the Bluetooth controller after Android stopped the app, and starts the app without UI when a matching device advertises. It needs a `services` or `manufacturerData` filter. Android 10 and 11 also need background location (`android.backgroundLocation`).
- A companion device (`android.companionDevice`, then `BleManager.android.associateCompanionDevice`) can start the app when it comes into range or leaves, from Android 12 (`devicePresence`). The person picks the device in a system dialog, and no location permission is involved.

### Battery savers

Doze and App Standby delay background work, and some manufacturers stop background apps more aggressively than stock Android. What holds up:

- A foreground service survives battery optimization: it's what Android offers for an ongoing task the person knows about.
- Background scans and companion wake-ups come from the system's Bluetooth stack, so they don't depend on the app's process staying alive.
- If a phone still stops your app, the person can set its battery use to "Unrestricted" in the app's settings. [dontkillmyapp.com](https://dontkillmyapp.com) lists what each manufacturer does.

### Google Play review

- **Foreground service type.** Apps targeting Android 14 or later declare each foreground service type in Play Console (App content → Foreground service permissions): what the feature does, what happens to the person if Android delays or interrupts it, a video showing how to start it, and a use case. For `connectedDevice`, the use case is "Continuous Data Transfer to an External Device".
- **Background location.** Only if you set `android.backgroundLocation` (background scans on Android 10 and 11). Play asks for the Permissions Declaration Form (App content → Sensitive app permissions → Location permissions) for one feature that needs it, a short video (Play suggests 30 seconds or less) showing the feature, a prominent in-app disclosure before the permission prompt that mentions location and background use, and a privacy policy. If your app can do without background scans on Android 10 and 11, leave the option off and none of this applies.
- **Scanning without location.** On Android 12 and later, the plugin declares `BLUETOOTH_SCAN` with `neverForLocation`, so scanning needs no location permission. Keep it unless your app derives location from Bluetooth (beacons).

## Testing background behavior

- iOS: `e2e/ios-restoration/run.sh` connects the example app to a test peripheral, stops the app the way iOS does, and checks the task's events in the restoration journal. Background behavior can't be tested in the Simulator, which has no Bluetooth.
- Android: `adb shell am kill <package>` stops a backgrounded app the way the system does; `adb shell am force-stop` is the force stop, which cancels background scans.
- The scenarios this library is checked against, and their results per device, are in `docs/qa/background.md` in the repository.
