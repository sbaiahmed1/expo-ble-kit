---
title: Troubleshooting
---

# Troubleshooting

Each section starts with what you see. For a bug report, include the output of `await BleManager.getDiagnostics()`: it lists the adapter state, the permissions, every connection with its queue, and the last 100 errors.

## "The expo-ble-kit native module is missing" (`NOT_SUPPORTED`)

The app runs without the native code:

- **Expo Go** doesn't include it. Use a [development build](https://docs.expo.dev/develop/development-builds/introduction/).
- After installing the package, **rebuild** the app (`npx expo run:ios` or `run:android`). Reloading JavaScript isn't enough.
- **In Jest**, install the fake first: `installFakeBle()` from `expo-ble-kit/testing`.

## Nothing works in the iOS Simulator

The Simulator has no Bluetooth: the adapter state stays `unsupported` or `unknown`. Test on an iPhone. On the Simulator, use the fake (`expo-ble-kit/testing`) to work on screens.

## The app crashes at launch on iOS 27

An SDK 57 app built with Xcode 27 must adopt the UIScene life cycle. Add `expo-build-properties` with `{ "ios": { "enableSceneSupport": true } }` and rebuild. SDK 58 apps don't need it.

## `MISCONFIGURED`

The app lacks a declaration: the iOS permission text, or an Android permission for this API level. The message names it. Add the config plugin to `app.json` and rebuild, or follow the [bare setup guide](guides/bare-setup.md).

## Android: `CONNECTION_FAILED` with status 133

Status 133 (`GATT_ERROR`) is Android's catch-all for a failed connection. expo-ble-kit already retries it up to three times within the connect timeout. If it keeps failing:

- The device may be out of range, asleep, or connected to another phone or app. Many peripherals accept only one connection.
- Scan for the device shortly before connecting (see the next section).
- Disconnect cleanly before connecting again. Every connection attempt is closed, so leaks don't build up: `getDiagnostics()` shows `android.openGattClients`, which should come back to 0 when nothing is connected.
- Turning Bluetooth off and on resets a stuck Android Bluetooth stack.

## Android: reconnecting by a saved id fails or times out

On Android the id is the device's address. Many devices use a **random address**, and Android can only connect to one reliably if it has seen it in a scan since the app started: an address alone doesn't say which kind it is. Run a short scan before connecting to a stored id:

```ts
const found = await BleManager.scanFor({
  timeoutMs: 5_000,
  services: [MY_SERVICE],
  match: (result) => result.id === savedId,
});
if (found) await BleManager.getPeripheral(found.id).connect();
```

Some devices also change their address over time (privacy): then the saved id is useless, and the app has to find the device by its services, name or manufacturer data. Android accepts any well-formed address in `getKnownPeripherals()` and `getPeripheral()`, because it can't tell whether a device exists without connecting.

## Android 11 and earlier: scans find nothing

On API 30 and below, scans return nothing while **location services** (the system "Location" switch) are off, even with the location permission granted. Ask the user to turn location on. Also check that `requestPermissionsAsync()` resolved with `scan: 'granted'`.

## Android: `SCAN_THROTTLED` warning, or scans start late

Android allows five scan starts per 30 seconds per app. Beyond that it silently returns nothing; expo-ble-kit instead delays the start until it is allowed. Avoid starting and stopping scans in quick succession: keep one scan running, or use `scanFor` with a filter.

## `INVALID_ATTRIBUTE_LENGTH` on a write

A write with response takes up to 512 bytes. A write without response must fit in one packet: MTU − 3 bytes (20 at the default MTU of 23). On Android, connecting asks for an MTU of 517 by default; check `peripheral.mtu`, or call `requestMtu()`. On iOS the system chooses the MTU.

## `SERVICE_NOT_FOUND` or `CHARACTERISTIC_NOT_FOUND`

The attribute isn't in the discovery cache. With the default `autoDiscover: true`, `connect()` discovers everything; with `autoDiscover: false`, call `discover()` first. Check `peripheral.services` to see what the device offers.

## Notifications stop arriving

A subscription ends with the connection: after a disconnect, subscribe again once connected. `useCharacteristicValue` does this for you.
