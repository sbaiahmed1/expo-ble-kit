---
title: Getting started
---

# Getting started

expo-ble-kit lets an Expo or React Native app talk to Bluetooth Low Energy devices: find them (scan), connect, read and write their values, and receive their notifications.

## Requirements

- **Expo SDK 57 or later**, in a [development build](https://docs.expo.dev/develop/development-builds/introduction/) or a bare React Native app with `expo` installed. Expo Go doesn't include the native code, so it can't run it.
- **iOS 16.4+** on a real device. The iOS Simulator has no Bluetooth.
- **Android 8.0 (API 26)+**. The config plugin raises the app's `minSdkVersion` to 26.
- The New Architecture (the default since SDK 53).

> **Xcode 27:** an SDK 57 app built with Xcode 27 crashes at launch on iOS 27 unless it adopts the UIScene life cycle. Add [`expo-build-properties`](https://docs.expo.dev/versions/latest/sdk/build-properties/) with `{ "ios": { "enableSceneSupport": true } }` (needs `expo` 57.0.23 or later). SDK 58 apps don't need it.

## Install

```bash
npx expo install expo-ble-kit
```

Add the config plugin to `app.json`, so the app declares what Bluetooth needs:

```json
{
  "expo": {
    "plugins": [
      [
        "expo-ble-kit",
        { "bluetoothAlwaysPermission": "Allow $(PRODUCT_NAME) to connect to your heart rate monitor." }
      ]
    ]
  }
}
```

Then rebuild the app (`npx expo run:ios`, `npx expo run:android`, or an EAS build). A JavaScript reload isn't enough after adding a native module.

Plugin options:

| Option | Default | What it does |
|---|---|---|
| `bluetoothAlwaysPermission` | A generic sentence | The iOS permission text (`NSBluetoothAlwaysUsageDescription`). Write your own: App Review reads it. `false` skips it, for apps that set it elsewhere. |
| `android.neverForLocation` | `true` | Tells Android 12+ that the app doesn't derive location from scans, so scanning needs no location permission. Set `false` only if you do. |
| `android.requireBleHardware` | `false` | Lists Bluetooth LE as required on Google Play, which hides the app from devices without it. |

Not using prebuild? Follow the [bare setup guide](guides/bare-setup.md).

## The shape of the API

- **`BleManager`**: the adapter state, permissions, scanning, and peripherals by id.
- **`Peripheral`**: one remote device. Connect, discover, read, write, subscribe.
- **Hooks**: `useBleState`, `useBlePermissions`, `useScan`, `usePeripheral`, `useCharacteristicValue`.
- **`BleError`**: every failure, with a `code` you can test.

Values are bytes: `Uint8Array` in and out. UUIDs can be written short (`'180d'`, `0x180d`) or long; results always use the long lowercase form (`0000180d-0000-1000-8000-00805f9b34fb`). `GattServices` and `GattCharacteristics` hold common ones.

## Permissions first

Nothing shows a permission prompt except `requestPermissionsAsync()`.

```ts
import { BleManager } from 'expo-ble-kit';

const permissions = await BleManager.requestPermissionsAsync();
if (permissions.scan !== 'granted' || permissions.connect !== 'granted') {
  // Explain why the app needs Bluetooth; if canAskAgain is false, send the user to Settings.
}
```

The [permissions guide](guides/permissions.md) explains what each platform asks for.

## Scan

```ts
import { BleManager, GattServices } from 'expo-ble-kit';

// Stops at the first match, or resolves null after 10 s.
const found = await BleManager.scanFor({ services: [GattServices.HeartRate], timeoutMs: 10_000 });

// Or keep scanning and stop yourself.
const session = BleManager.startScan(
  { services: [GattServices.HeartRate] },
  (results) => results.forEach((r) => console.log(r.id, r.name, r.rssi)),
  (error) => console.warn('scan ended', error.code)
);
// later
session.stop();
```

Filter by `services` whenever you can: it saves battery, and iOS needs it to scan in the background. Several scans may run at once; each gets only its own matches.

## Connect, read, write

```ts
import { BleManager, GattCharacteristics, GattServices } from 'expo-ble-kit';

const device = BleManager.getPeripheral(found.id);
await device.connect(); // 15 s timeout; discovers every service first

const level = await device.read(GattServices.Battery, GattCharacteristics.BatteryLevel);
console.log('battery', level[0], '%');

await device.write(MY_SERVICE, MY_CHARACTERISTIC, Uint8Array.of(0x01));
await device.disconnect();
```

Operations on one device run one at a time, in order, and each has a timeout (10 s by default). If the connection drops, every pending operation rejects with `DISCONNECTED`.

A write without response (`{ withResponse: false }`) takes one packet (`device.mtu - 3` bytes) and resolves once the phone's Bluetooth stack has taken it. It waits while the stack is full, so nothing is dropped on the phone: to send a lot of data fast, issue several writes before awaiting them, and they go out in order.

## Sending a lot of data

`writeStream` sends a payload of any length in chunks of one packet, natively, with progress:

```ts
const controller = new AbortController();
await device.writeStream(MY_SERVICE, FIRMWARE_CHARACTERISTIC, image, {
  onProgress: (sent, total) => setProgress(sent / total), // about every 1 %, and at the end
  signal: controller.signal, // abort() stops it within the chunk in flight
});
```

Chunks go without response by default; `withResponse: true` waits for the peripheral to acknowledge each one (some firmware-update protocols need it), and `chunkSize` makes them smaller. `timeoutMs` applies to each chunk. Other operations issued during a stream wait until it ends.

Several devices can be connected at once: each `Peripheral` has its own operation queue and connection, so a slow or lost device doesn't affect the others. Android handles about 7 connections at once (see [troubleshooting](troubleshooting.md#android-some-of-several-devices-fail-to-connect)).

## Notifications

```ts
const subscription = await device.subscribe(
  GattServices.HeartRate,
  GattCharacteristics.HeartRateMeasurement,
  (value, timestamp) => {
    const bpm = value[0] & 0x01 ? value[1] | (value[2] << 8) : value[1]; // flags bit 0: 16-bit value
    console.log(bpm, 'bpm at', new Date(timestamp));
  }
);
// later
await subscription.unsubscribe();
```

Several subscriptions to one characteristic share it: the peripheral's notifications are turned off when the last one is removed. A subscription ends with the connection, unless the connection reconnects (below).

## Staying connected

Pass a `reconnect` policy and the library brings a lost connection back by itself:

```ts
await device.connect({ reconnect: { maxAttempts: 5 } }); // waits 1, 2, 4, 8, 16 s between attempts

device.addConnectionStateListener((state, error) => {
  // 'connected' → 'reconnecting' (error: why the link was lost) → 'connected'
  // or, after the last attempt, 'disconnected' with the last attempt's error
});
```

- Reconnection starts only after an established connection is lost unexpectedly. A first `connect()` that fails still rejects, and `disconnect()` stops reconnecting.
- While reconnecting, operations reject with `DISCONNECTED`; services are discovered again before the state reads `connected`.
- Subscriptions are kept: notifications are turned on again before `connected`, and the same callbacks keep receiving values. One that can't be restored ends alone: its `active` turns false, and the reason is kept in `getDiagnostics().recentErrors`. `restoreSubscriptionsOnReconnect: false` ends them when the link is lost instead.
- `backoff: 'fixed'` waits `initialDelayMs` each time; the default doubles it up to `maxDelayMs` (30 s). `maxAttempts` defaults to no limit.
- On iOS 17 and later, `ios: { enableAutoReconnect: true }` lets the system reconnect first, which also works while the app is suspended.

For fast notifications (sensors at 50 Hz and more), `subscribeBatched` collects the values natively and calls you at most once per interval, which keeps the JS thread free:

```ts
const subscription = await device.subscribeBatched(
  SERVICE,
  ACCELEROMETER,
  ({ values, timestamps, dropped }) => {
    // values[i] arrived at timestamps[i]; dropped > 0 only if more than maxItems came in one interval
  },
  { intervalMs: 16 } // at most ~63 calls a second
);
```

When the peripheral's services change while connected (a firmware update, a service switched on), the library discovers them again and tells you; subscriptions on characteristics that are still there keep working:

```ts
device.addServicesChangedListener(() => {
  console.log('services now', device.services.map((s) => s.uuid));
});
```

Android reports service changes from Android 12. On older versions, or when a device's cached services are wrong, `await device.android.refreshGattCache()` clears Android's cache and discovers again (it uses a hidden Android API and resolves `false` where that isn't available).

## Staying connected in the background (Android)

Android may stop a backgrounded app at any time. `keepAliveInBackground` keeps it running while the connection is open, with a foreground service and its notification:

```json
{ "expo": { "plugins": [["expo-ble-kit", { "android": { "foregroundService": true } }]] } }
```

```ts
BleManager.android.setForegroundServiceNotification({ title: 'My Sensor', text: 'Recording' });
await device.connect({ keepAliveInBackground: true, reconnect: { maxAttempts: 10 } });
```

- The service starts with the connect and stops when the connection ends: `disconnect()`, a failed connect, or reconnection giving up. Reconnecting keeps it.
- Connect while the app is in the foreground. Android 12 and later refuse to start the service from the background; the library then sends a `FOREGROUND_SERVICE_FAILED` warning to the log, and the connection goes on without the service.
- Without the plugin option, `keepAliveInBackground: true` rejects with `MISCONFIGURED`. Google Play asks apps that declare the service type to describe it in Play Console.
- On Android 13 and later, the notification appears in the drawer once the user allows notifications (`POST_NOTIFICATIONS`, which your app requests); the service runs either way.
- `getDiagnostics().android.foregroundService` tells whether it runs.
- iOS: not supported yet (rejects with `NOT_SUPPORTED`); it comes with background modes.

## With React hooks

```tsx
import { useBleState, useCharacteristicValue, usePeripheral, useScan } from 'expo-ble-kit';

function HeartRate({ id }: { id: string }) {
  const { peripheral, state, error } = usePeripheral(id);
  const { value } = useCharacteristicValue(peripheral, '180d', '2a37');
  if (state !== 'connected') {
    return <Button title="Connect" onPress={() => peripheral?.connect()} />;
  }
  return <Text>{value ? `${value[1]} bpm` : '…'}</Text>;
}

function Nearby() {
  const bluetooth = useBleState(); // 'poweredOn', 'poweredOff', …
  const { results, isScanning, error } = useScan({ services: ['180d'] });
  // results: the latest result per device
}
```

`useScan` starts when the component mounts (pass `enabled: false` to wait) and stops when it unmounts. It starts again by itself when Bluetooth comes back on.

## Errors

Every failure is a `BleError`. Test its `code`, not its message:

```ts
import { BleError, BleErrorCode } from 'expo-ble-kit';

try {
  await device.connect({ timeoutMs: 5_000 });
} catch (error) {
  if (error instanceof BleError && error.code === BleErrorCode.CONNECTION_TIMEOUT) {
    // Out of range?
  }
}
```

`error.retryable` says whether trying again can help, and `peripheralId`, `serviceUUID` and `characteristicUUID` say what the error is about. When reporting a bug, include `await BleManager.getDiagnostics()`.

## Cancelling

Every operation takes an `AbortSignal`:

```ts
const controller = new AbortController();
const reading = device.read(SERVICE, CHARACTERISTIC, { signal: controller.signal });
controller.abort(); // rejects with OPERATION_CANCELLED; a queued read never reaches the radio
```

`connect({ timeoutMs: null })` waits until the device appears ("connect when in range"); `disconnect()` or a signal cancels it.

## Logging

```ts
BleManager.setLogLevel('debug'); // 'none' | 'error' | 'warn' (default) | 'info' | 'debug' | 'verbose'
BleManager.setLogHandler((entry) => console.log(entry.level, entry.peripheralId, entry.opId, entry.message));
```

At `debug`, every GATT operation logs a line like `read 0c6c1001-…: ok in 34 ms` with its operation id. Logs also go to Logcat (tag `BleKit`) and to the unified log on iOS (subsystem `expo.blekit`). `setLogHandler(null)` stops the handler.

## Testing your app

`expo-ble-kit/testing` replaces the native module with virtual peripherals in Jest:

```ts
import { installFakeBle } from 'expo-ble-kit/testing';
import { GattCharacteristics, GattServices } from 'expo-ble-kit';

const ble = installFakeBle();
const hrm = ble.addPeripheral({
  name: 'HRM',
  services: [
    {
      uuid: GattServices.HeartRate,
      characteristics: [{ uuid: GattCharacteristics.HeartRateMeasurement, properties: ['notify'] }],
    },
  ],
});
// render the screen under test, then:
hrm.notify(GattServices.HeartRate, GattCharacteristics.HeartRateMeasurement, Uint8Array.of(0, 72));
```

The fake answers on later timer ticks, like a radio; Jest fake timers work (`await jest.advanceTimersByTimeAsync(10)`). `ble.injectError({ op: 'read' }, 'INSUFFICIENT_AUTHENTICATION')` makes the next read fail.

## Not in this version yet

Background operation on iOS (background modes, state restoration), background scanning and background tasks, and the peripheral role (advertising, GATT server) come in later versions. Options for them reject with `NOT_SUPPORTED` rather than being ignored.

Problems? See [troubleshooting](troubleshooting.md).
