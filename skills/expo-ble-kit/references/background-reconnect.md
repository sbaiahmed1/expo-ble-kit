# Recipe: background work and reconnection

Keeping a device connected when the app isn't in front, coming back after a drop, and waking the app when a device shows up. Pick what the app needs; each part has its own config.

## 1. Reconnect after a drop (both platforms, no config)

```ts
const device = BleManager.getPeripheral(savedId);
await device.connect({
  reconnect: { maxAttempts: Infinity, initialDelayMs: 1_000, maxDelayMs: 30_000 }, // `{}` gives these defaults
});
device.addConnectionStateListener((state, error) => {
  // 'connected' → 'reconnecting' (error: why the link was lost) → 'connected', or after the
  // last attempt 'disconnected' with the last attempt's error.
});
```

- Reconnection starts only after a working connection is lost. A first `connect()` that fails rejects; retry it yourself if you want (`CONNECTION_FAILED` and `CONNECTION_TIMEOUT` are retryable).
- Subscriptions survive: notifications are turned on again before `connected`, and the same callbacks keep receiving values. `useCharacteristicValue` follows along by itself.
- While reconnecting, operations reject with `DISCONNECTED`. `disconnect()` stops reconnecting.
- At app start, reconnect to a saved device with `connect({ timeoutMs: null, reconnect: {} })`: with no timeout the connect waits until the device is in range.
- iOS 17+: `ios: { enableAutoReconnect: true }` lets iOS reconnect by itself, even while the app is suspended.

## 2. Stay connected in the background

**iOS**: declare the `bluetooth-central` background mode; iOS then keeps connections, notifications and filtered scans going in the background:

```json
["expo-ble-kit", { "ios": { "backgroundModes": ["central"] } }]
```

**Android**: a foreground service keeps the app alive while the connection is open. Declare it, then connect with `keepAliveInBackground` while the app is in the foreground (Android 12+ refuses to start the service from the background; the library logs a `FOREGROUND_SERVICE_FAILED` warning and goes on without it):

```json
["expo-ble-kit", { "android": { "foregroundService": true } }]
```

```ts
BleManager.android.setForegroundServiceNotification({ title: 'Acme Sensor', text: 'Recording your workout' });
await device.connect({ keepAliveInBackground: true, reconnect: {} });
```

The service stops when the connection ends. On Android 13+, request `POST_NOTIFICATIONS` (for example with `expo-notifications` or `PermissionsAndroid`) to show its notification in the drawer; it runs either way. Google Play asks apps declaring the `connectedDevice` service type to justify it.

## 3. Background tasks with `expo-task-manager`

When the system stopped the app, the library starts it without UI and hands events to a task. Define the task at module scope (in the app's entry file or a file it imports first), not in a component:

```bash
npx expo install expo-task-manager
```

```ts
// index.ts (before registerRootComponent) or a module it imports
import * as TaskManager from 'expo-task-manager';
import type { BleBackgroundEvent } from 'expo-ble-kit';

export const BLE_TASK = 'ble-background';

TaskManager.defineTask<BleBackgroundEvent>(BLE_TASK, async ({ data, error }) => {
  if (error || !data) return;
  switch (data.type) {
    case 'scanResults': // Android background scan
      data.results.forEach((result) => console.log('nearby', result.id, result.rssi));
      break;
    case 'devicePresence': // Android 12+ companion device
      console.log(data.peripheralId, data.present ? 'in range' : 'gone');
      break;
    case 'restored': // iOS relaunched the app and handed connections back
      console.log('restored', data.peripheralIds);
      break;
    case 'notification': // iOS, while in the background
      save(data.peripheralId, data.characteristic, data.value, data.timestamp);
      break;
    case 'connectionStateChange': // iOS, while in the background
      console.log(data.peripheralId, data.state);
      break;
  }
});
```

Register it once from the app (a screen or startup code); registering again with other options replaces them:

### Android: wake up when a device advertises

```ts
await BleManager.requestPermissionsAsync({ backgroundScan: true });
await BleManager.registerBackgroundTask(BLE_TASK, {
  events: ['scanResults'],
  scan: { services: [MY_SERVICE] }, // services or manufacturerData required: the controller filters
});
```

Android 10–11 also need background location (plugin `android.backgroundLocation: true`). The scan survives Android stopping the app, not a force stop; `unregisterBackgroundTask(BLE_TASK)` ends it.

### Android: companion devices

```json
["expo-ble-kit", { "android": { "companionDevice": true } }]
```

```ts
const device = await BleManager.android.associateCompanionDevice({ services: [MY_SERVICE] }); // system dialog
if (device) await BleManager.registerBackgroundTask(BLE_TASK, { events: ['devicePresence'] }); // Android 12+
```

No scan permission is needed for the dialog (Location Services must be on). Devices with a rotating random address need bonding to be recognized later (`device.android.createBond()` once connected).

### iOS: state restoration

```json
["expo-ble-kit", { "ios": { "backgroundModes": ["central"], "restoreIdentifier": "com.example.app" } }]
```

```ts
await BleManager.registerBackgroundTask(BLE_TASK, {
  events: ['restored', 'notification', 'connectionStateChange'],
});
```

When iOS stops the app to free memory, it keeps the connections and relaunches the app in the background for their events. At launch the library hands them back: connected ones are `connected` with their notifications still on. In the foreground, subscribe as usual; a restored characteristic is already on. iOS doesn't relaunch an app the person closed from the app switcher. `getDiagnostics().ios.restoration.journal` lists what happened around relaunches.

## 4. Test it

Background delivery itself needs a device, but the registration logic runs against the fake:

```ts
import { installFakeBle } from 'expo-ble-kit/testing';

installFakeBle();
await BleManager.registerBackgroundTask(BLE_TASK, { events: ['devicePresence'] }); // Platform.OS 'android' in the test
```

To exercise the task function, export it and call it with a `BleBackgroundEvent` you build in the test.
