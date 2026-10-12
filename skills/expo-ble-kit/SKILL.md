---
name: expo-ble-kit
description: Bluetooth Low Energy in Expo and React Native apps with expo-ble-kit. Use when an app scans for, connects to, reads, writes or subscribes to BLE devices (heart-rate straps, sensors, locks, custom boards), keeps them connected in the background, acts as a BLE peripheral (GATT server, advertising), or tests BLE code with the fake in Jest.
---

# expo-ble-kit

An Expo module for Bluetooth Low Energy: the phone as a central (scan, connect, GATT client) and as a peripheral (GATT server, advertising), with background work, typed errors, React hooks and a test fake. Values are `Uint8Array` everywhere; there is no base64.

Recipes, each a complete worked example:

- [Heart rate monitor](references/heart-rate.md): scan, connect, subscribe, parse the Heart Rate Measurement, hooks, and a Jest test with the fake.
- [Streaming and firmware-style transfers](references/streaming-transfer.md): `writeStream` with progress and cancel, fast notifications with `subscribeBatched`, throughput settings.
- [Background and reconnection](references/background-reconnect.md): reconnect policies, keeping a connection alive in the background, iOS state restoration, Android background scans and companion devices, all through `expo-task-manager`.

## Setup

```bash
npx expo install expo-ble-kit
```

It needs a development build (`npx expo run:ios` / `run:android`) or a bare app with `expo`: Expo Go has no Bluetooth code, and the iOS Simulator has no Bluetooth. New Architecture only.

The config plugin declares the permissions at build time. Add it, then rebuild:

```json
{ "expo": { "plugins": [["expo-ble-kit", { "bluetoothAlwaysPermission": "Allow $(PRODUCT_NAME) to connect to your sensor." }]] } }
```

Options (all optional), only what the app uses:

| Option | For |
| --- | --- |
| `ios.backgroundModes: ['central']` | connections, scans and notifications while in the background on iOS |
| `ios.backgroundModes: ['peripheral']` | the GATT server and advertising in the background on iOS |
| `ios.restoreIdentifier: 'com.example.app'` | iOS state restoration (needs `central`) |
| `ios.accessorySetupKit: { services, names, companyIdentifiers }` | `BleManager.ios.showAccessoryPicker` (iOS 18+) |
| `android.foregroundService: true` | `connect({ keepAliveInBackground: true })` |
| `android.backgroundLocation: true` | background scans on Android 10–11 |
| `android.advertise: true` | `startAdvertising` (BLUETOOTH_ADVERTISE) |
| `android.companionDevice: true` | `BleManager.android.associateCompanionDevice` and `devicePresence` tasks |
| `android.neverForLocation: false` | only if the app derives location from scans (default true) |

A missing declaration makes the call reject with `MISCONFIGURED` naming the option, never a crash. Bare apps without prebuild add the entries by hand: `docs/guides/bare-setup.md` in the package's repository.

## The rules that matter

1. **Permissions first, then the state.** `await BleManager.requestPermissionsAsync()` before scanning or connecting. Android 12+ shows the scan and connect prompts; on iOS the first call creates the Bluetooth manager, which shows the one prompt. Reading the state, the hooks and `getPermissionsAsync()` never prompt.
   - Before permission, the state isn't `poweredOn`: iOS reports `unknown` until the person answered, Android 12+ `unauthorized` until connect is granted. So **never disable the button that asks for permission until `poweredOn`**: disable it only for `poweredOff` and `unsupported`, or the app can never ask.
   - States: `unknown`, `resetting`, `unsupported`, `unauthorized`, `poweredOff`, `poweredOn`. Scans and connects made while not `poweredOn` reject at once, they don't wait: `BLUETOOTH_POWERED_OFF`, `BLUETOOTH_UNAUTHORIZED`, `BLUETOOTH_UNSUPPORTED`, or `BLUETOOTH_RESETTING` (for `unknown` and `resetting`). To wait, `BleManager.addStateListener((state) => …)` returns `{ remove() }`, or re-render on `useBleState()`.
   - `requestPermissionsAsync(request?)` resolves `{ scan, connect, advertise, backgroundScan, canAskAgain }`, each status `'granted' | 'denied' | 'undetermined'`; `canAskAgain` false means only Settings can change it. Without a request it asks for scan and connect; `{ advertise: true }` or `{ backgroundScan: true }` ask for those. On iOS one prompt covers everything, and the statuses all follow it.
2. **UUIDs**: pass 16-bit (`'180D'`, `0x180d`) or 128-bit strings; the library always gives back lowercase 128-bit ones. Use `GattServices.HeartRate`, `GattCharacteristics.HeartRateMeasurement` and the other constants where they exist.
3. **One operation at a time is handled for you.** Each connection has a queue: start reads and writes freely (even with `Promise.all`), they run in order. Every operation has a timeout (10 s, 30 s for discovery, 15 s for connect); `timeoutMs` changes it and `signal: AbortSignal` cancels it. Don't build your own queue or add sleeps between operations.
4. **`connect()` resolves when the device is ready**: the link is up and every service is discovered (`autoDiscover`, default true), so you can read right away. The `connected` state means the same. Connection states: `disconnected` (also a peripheral never connected), `connecting`, `connected`, `reconnecting` (with a reconnect policy), `disconnecting`. `disconnect()` during a connect cancels it: the connect rejects with `OPERATION_CANCELLED`. `connect()` on a connected peripheral resolves at once.
5. **Keep subscriptions and end them.** `subscribe()` resolves once notifications are on and returns a `CharacteristicSubscription`; call `remove()` (or `await unsubscribe()`) in cleanup. A disconnect ends them unless a reconnect policy restores them.
6. **Catch `BleError` and switch on `error.code`** (`BleErrorCode`), never on messages. `error.retryable` says whether trying again can work.
7. **Peripheral ids are per platform**: a MAC address on Android, a per-app UUID on iOS, a browser id on the web. Store the id you connected to and reconnect with `BleManager.getPeripheral(id)`; don't share ids between platforms.
8. **Write sizes**: with response up to 512 bytes; without response one packet (MTU − 3, 20 bytes until a larger MTU). Use `writeStream` for anything longer.

## The API

```ts
import { BleManager, BleError, BleErrorCode, GattServices, GattCharacteristics } from 'expo-ble-kit';

// Find one device: resolves the first match, or null after timeoutMs; signal aborts it (OPERATION_CANCELLED).
const found = await BleManager.scanFor({ services: [GattServices.HeartRate], timeoutMs: 10_000, signal });

// Or keep scanning: results come in batches; several scans can run at once.
const session = BleManager.startScan(
  { services: [MY_SERVICE], namePrefix: 'Acme', allowDuplicates: false },
  (results) => results.forEach((r) => console.log(r.id, r.name, r.rssi, r.manufacturerData)),
  (error) => console.warn(error.code) // the scan ended: Bluetooth off, permission, throttled…
);
session.stop();

const device = BleManager.getPeripheral(found!.id); // no I/O; the same object for the same id
await device.connect({ timeoutMs: 10_000 });
const value = await device.read(MY_SERVICE, MY_CHARACTERISTIC); // Uint8Array
await device.write(MY_SERVICE, CONTROL, Uint8Array.of(0x01)); // with response by default
await device.write(MY_SERVICE, CONTROL, Uint8Array.of(0x02), { withResponse: false });
const subscription = await device.subscribe(MY_SERVICE, SENSOR, (value, timestamp) => {});
subscription.remove();
device.addConnectionStateListener((state, error) => {}); // returns { remove() }
await device.disconnect();
```

Also on `Peripheral`: `discover(services?)`, `services` (the discovered tree), `readDescriptor` / `writeDescriptor`, `writeStream`, `subscribeBatched`, `readRssi()`, `requestMtu(mtu)` (Android negotiates; iOS reports its own), `mtu`, `name`, `state`, `addServicesChangedListener`, and on Android `android.createBond()`, `android.requestConnectionPriority('high')`, `android.setPreferredPhy(['le2m'], ['le2m'])`, `android.refreshGattCache()`. L2CAP channels: `openL2CAPChannel(psm)`.

On `BleManager`: `state`, `addStateListener`, `getPermissionsAsync` / `requestPermissionsAsync({ scan, connect, advertise, backgroundScan })`, `startScan`, `scanFor`, `getPeripheral`, `getKnownPeripherals(ids)`, `getSystemConnectedPeripherals(services)`, `openGattServer(services)`, `startAdvertising(data, options)`, `publishL2CAPChannel()`, `registerBackgroundTask(name, options)` / `unregisterBackgroundTask(name)`, `ios.showAccessoryPicker(items)`, `android.associateCompanionDevice(filter)`, `android.isLocationServicesEnabled()`, `android.setForegroundServiceNotification(...)`, `setLogLevel('debug')`, `setLogHandler(fn)`, `getDiagnostics()`.

### Hooks

```tsx
import { useBleState, useBlePermissions, useScan, usePeripheral, useCharacteristicValue } from 'expo-ble-kit';

const state = useBleState(); // 'poweredOn' …
const [permissions, request] = useBlePermissions(); // permissions null until read
const { results, isScanning, error, start, stop, clear } = useScan({ services: [MY_SERVICE], enabled: true });
const { peripheral, state: connection, error: connectionError } = usePeripheral(deviceId);
const { value, error: valueError } = useCharacteristicValue(peripheral, MY_SERVICE, SENSOR); // subscribes while connected
const battery = useCharacteristicValue(peripheral, GattServices.Battery, GattCharacteristics.BatteryLevel, { mode: 'read' });
```

- `useBlePermissions()` reads the permissions on mount and when the app comes back to the foreground; `permissions` is null until read; `request(flags?)` is `requestPermissionsAsync` and updates it.
- `usePeripheral(id)` returns the same object as `BleManager.getPeripheral(id)` (one object per id), so connecting through either is the same; for a null id it gives `{ peripheral: null, state: 'disconnected', error: null }`. `error` is a `BleError` (why the last connection ended or failed), cleared when it connects again. It never connects by itself: call `peripheral.connect()` from a button or an effect.
- `useCharacteristicValue` subscribes (or reads, with `mode: 'read'`) whenever the peripheral is connected, again after a reconnection. `value` is null until the first value, is kept across a disconnect (show `state` next to it), and resets when the peripheral or characteristic changes. `error` clears once subscribing or reading succeeds again. `batchMs` limits renders for fast sensors.
- `useScan` restarts when its options change.

### Errors

| Code | Meaning, and what to do |
| --- | --- |
| `BLUETOOTH_POWERED_OFF`, `BLUETOOTH_UNAUTHORIZED`, `BLUETOOTH_UNSUPPORTED` | Ask the person to turn Bluetooth on or allow it; wait for `poweredOn` |
| `PERMISSION_DENIED` | A runtime permission is missing: `requestPermissionsAsync()`; if `canAskAgain` is false, send them to Settings |
| `MISCONFIGURED` | A config plugin option is missing; the message names it. Fix the config and rebuild |
| `CONNECTION_FAILED`, `CONNECTION_TIMEOUT` | Out of range or busy; retry (they are retryable) |
| `DISCONNECTED` | The link went down during the operation |
| `OPERATION_TIMEOUT`, `OPERATION_CANCELLED` | The timeout passed, or your `signal` aborted it |
| `SERVICE_NOT_FOUND`, `CHARACTERISTIC_NOT_FOUND` | Wrong UUID, or a different firmware |
| `READ_NOT_PERMITTED`, `WRITE_NOT_PERMITTED`, `NOT_SUPPORTED` | The characteristic doesn't allow it (check `properties`), or the platform can't |
| `INSUFFICIENT_AUTHENTICATION`, `INSUFFICIENT_ENCRYPTION` | The device needs pairing; on Android `device.android.createBond()`, on iOS the system prompts |
| `SCAN_THROTTLED` | Android allows 5 scan starts per 30 s; the library delays the next one |
| `INVALID_ARGUMENT` | A bad UUID, size or option; the message says which |

```ts
try {
  await device.read(SERVICE, CHARACTERISTIC);
} catch (e) {
  const error = BleError.fromNative(e); // BleError either way
  if (error.code === BleErrorCode.DISCONNECTED) await device.connect();
  else throw error;
}
```

## The phone as a peripheral

```ts
import { BleError, BleErrorCode, BleManager, normalizeUUID } from 'expo-ble-kit';

const STATUS = normalizeUUID('…'); // requests carry lowercase 128-bit UUIDs: compare normalized ones
const server = await BleManager.openGattServer([
  {
    uuid: MY_SERVICE,
    characteristics: [
      { uuid: STATUS, properties: ['read', 'notify'], permissions: ['readable'] },
      { uuid: COMMAND, properties: ['write'], permissions: ['writeable'] },
      { uuid: VERSION, properties: ['read'], permissions: ['readable'], value: Uint8Array.of(1) }, // static: answered for you
    ],
  },
]);
// One handler per server for every dynamic characteristic; throw a BleError to refuse.
server.onReadRequest(({ characteristic }) => {
  if (characteristic === STATUS) return Uint8Array.of(currentStatus);
  throw new BleError(BleErrorCode.READ_NOT_PERMITTED, 'Not readable');
});
server.onWriteRequest(({ characteristic, value }) => {
  if (characteristic !== normalizeUUID(COMMAND)) throw new BleError(BleErrorCode.WRITE_NOT_PERMITTED, 'Not writable');
  handle(value);
});
await server.notify(STATUS, Uint8Array.of(nextStatus)); // resolves once every subscriber took it: await it to pace a stream
const advertisement = await BleManager.startAdvertising({ localName: 'Acme', serviceUUIDs: [MY_SERVICE] });
await advertisement.stop();
await server.close();
```

Handlers must answer within 25 s. iOS advertises only the name and service UUIDs (no name in the background); Android needs `android.advertise` in the plugin options and advertises the phone's own Bluetooth name.

## Platforms

- **iOS**: no MTU negotiation (it picks), no bonding API (pairing prompts happen on encrypted reads), `mode: 'indicate'` isn't available on a characteristic that also notifies.
- **Android**: up to about 7 connections at once; Android 8–9 connect one at a time; scanning 5 starts per 30 s; location services must be on for scans up to Android 11 (`BleManager.android.isLocationServicesEnabled()`).
- **Web** (Chrome, Edge): a scan opens the browser's device chooser and must start from a tap; the page may use only services named in the scan's `services` or `web.optionalServices`. No MTU, RSSI, reconnection policies, server or background.

## Testing in Jest

```ts
import { installFakeBle } from 'expo-ble-kit/testing';

const ble = installFakeBle(); // in beforeEach; replaces the native module
const sensor = ble.addPeripheral({
  name: 'Sensor',
  services: [{ uuid: MY_SERVICE, characteristics: [{ uuid: SENSOR, properties: ['read', 'notify'], value: Uint8Array.of(1) }] }],
});
sensor.notify(MY_SERVICE, SENSOR, Uint8Array.of(42));
ble.injectError({ op: 'read' }, 'INSUFFICIENT_AUTHENTICATION'); // the next read fails
ble.setState('poweredOff');
```

- The fake answers on later timer ticks, like a radio, and follows the same queue, timeout and error rules as the native code. A scan, a connect with discovery and a subscribe each take a few ticks: with Jest fake timers, advance them in a few rounds (`await act(() => jest.advanceTimersByTimeAsync(100))`), since each answer can re-render and start the next step from an effect. Reconnection waits its policy's delay (1 s first by default). With real timers, `await screen.findByText(...)` works too.
- `addPeripheral` advertises at once with its name and the UUIDs of its services, so filtered scans find it; `strap.id` is its id. `installFakeBle()` again (in `beforeEach`) starts over with a fresh fake; `ble.reset()` empties the current one.
- `installFakeBle({ state: 'poweredOff', permissions: { connect: 'denied' } })` starts from another state or with denied permissions (default: `poweredOn`, everything granted).
- `injectError` takes the code's string (`'READ_NOT_PERMITTED'`); `BleErrorCode.READ_NOT_PERMITTED` is the same string (`BleErrorCode` is an object of string constants).
- `strap.notify(...)` delivers the value to subscribers at once: call it inside `act` (`await act(async () => strap.notify(...))`) so React applies the update.
- `@testing-library/react-native` 14: `render`, `fireEvent.press` and `unmount` return promises: `await` them, or the press never happens. An awaited press also waits for the promise the handler returns: with fake timers, a handler that scans or connects then never finishes, because the timers only advance after the press. Write handlers as `onPress={() => void find()}`. React Native's `Button` shows its title upper-cased on Android: find buttons by `testID` in tests meant for both platforms.

## Moving from react-native-ble-plx

`expo-ble-kit/compat/plx` offers ble-plx's API (base64 values included) over expo-ble-kit, so an app moves by changing imports, then migrates screen by screen. Its gaps are listed in `docs/guides/migration-from-plx.md`.

## Debugging

`BleManager.setLogLevel('debug')` logs one line per GATT operation (Logcat tag `BleKit`, the iOS unified log, and `setLogHandler`). `await BleManager.getDiagnostics()` returns the state, permissions, every connection with its queue depth, and the last 100 errors: attach it to bug reports.
