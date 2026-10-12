# Moving from react-native-ble-plx

expo-ble-kit ships a layer with react-native-ble-plx 3.5.1's API: the same `BleManager`, `Device`, `Service`, `Characteristic` and `Descriptor` classes, base64 values, transaction ids, and `BleError` with ble-plx's numeric codes and messages. An app moves by changing its imports, then switches to expo-ble-kit's own API screen by screen when it wants to.

## 1. Swap the packages

```bash
npx expo install expo-ble-kit
npm uninstall react-native-ble-plx
```

In `app.json`, replace ble-plx's config plugin with expo-ble-kit's:

| ble-plx plugin option | expo-ble-kit plugin option |
|---|---|
| `bluetoothAlwaysPermission` | `bluetoothAlwaysPermission` |
| `neverForLocation` | `android.neverForLocation` |
| `isBackgroundEnabled` (Android: requires Bluetooth LE hardware) | `android.requireBleHardware` |
| `modes: ['peripheral']` | `ios.backgroundModes: ['peripheral']` |
| `modes: ['central']` | not available yet (iOS central background comes later) |

Then rebuild the app (`npx expo prebuild`, or `npx expo run:ios` / `run:android`). Bare apps follow the [bare setup guide](bare-setup.md).

## 2. Change the imports

```ts
// Before
import { BleManager, Device, State, BleError, BleErrorCode } from 'react-native-ble-plx';
// After
import { BleManager, Device, State, BleError, BleErrorCode } from 'expo-ble-kit/compat/plx';
```

Nothing else changes. Every class, method, enum and error code of ble-plx 3.5.1 is there, with the same names and values; `src/__tests__/plxApi.test.ts` checks it. The example app's **Checks → ble-plx compatibility** runs such code against a test peripheral (`example/src/lib/plxSample.ts`).

## What works the same

- `new BleManager()` returns one shared instance until `destroy()`. On iOS, creating it asks for Bluetooth permission, as ble-plx does.
- Values are base64 strings. Writes take base64; invalid input rejects with `CharacteristicInvalidDataFormat`.
- `onStateChange(listener, true)` calls the listener with the current state first.
- `startDeviceScan` runs one scan at a time; errors go to its listener. Android reports every advertisement, iOS only with `allowDuplicates`.
- `connectToDevice` doesn't discover: call `discoverAllServicesAndCharacteristics` next.
- Monitors: `remove()` and `cancelTransaction` end them with `OperationCancelled`, a disconnect with `DeviceDisconnected`, `destroy()` with `BluetoothManagerDestroyed`, as in ble-plx.
- Transaction ids cancel calls, and a new call with the same id cancels the earlier one.
- `onDeviceDisconnected` gets no error when the app disconnected, an error otherwise.
- `errorCodesToMessagesMapping` replaces the messages.

## What differs

- **`enable()` and `disable()`** reject with `BluetoothStateChangeFailed`: apps can't turn Bluetooth on or off on Android 13+, and expo-ble-kit doesn't offer it anywhere. Ask the user instead.
- **State restoration** (`restoreStateIdentifier`) isn't available yet: `restoreStateFunction` is called once with `null`.
- **Connection timeout:** without `timeout`, expo-ble-kit's default (15 s) applies; ble-plx waited forever on iOS. With `autoConnect`, the connect still waits as long as it takes.
- **Android MTU:** expo-ble-kit asks for 517 after connecting unless `requestMTU` says otherwise; ble-plx didn't ask.
- **Android state:** `state()` reports `Unauthorized` until the Bluetooth permissions are granted; ble-plx reported `PoweredOn` and failed later.
- **Attributes by UUID:** `Service`, `Characteristic` and `Descriptor` methods address their target by UUID. When a device has two instances of one UUID, the first is used.
- **Already connected:** `connectToDevice` on a connected device resolves at once (ble-plx on Android disconnected and connected again); `cancelDeviceConnection` on a disconnected device resolves.
- **Scan fields:** `solicitedServiceUUIDs` and `overflowServiceUUIDs` are always null, `rawScanRecord` is empty on iOS, and `localName` is the name the scan saw.
- **Errors:** `reason` holds expo-ble-kit's message, and `cause` the expo-ble-kit error itself. Some failures map to the nearest ble-plx code: a timeout is `OperationTimedOut`, a missing permission `BluetoothUnauthorized`, a refused read `CharacteristicReadFailed` with `attErrorCode`.
- **Log level** starts at `Warning`, and lines go to expo-ble-kit's log (`os.Logger` subsystem `expo.blekit`, Logcat tag `BleKit`).

## Mixing in expo-ble-kit's API

The layer runs on expo-ble-kit's public API, so both can be used in one app: a device the compat manager connected is connected for `BleManager.getPeripheral(id)` too. What ble-plx never had is only in expo-ble-kit's API: the GATT server and advertising, L2CAP channels, bonding and PHY on Android, `writeStream`, batched notifications, reconnection policies, background scans on Android, React hooks, and the test fake.

## Moving to expo-ble-kit's API

| ble-plx | expo-ble-kit |
|---|---|
| `new BleManager()` | `BleManager` (a module object, no instance) |
| `manager.onStateChange(cb, true)` | `useBleState()`, or `BleManager.state` and `BleManager.addStateListener(cb)` |
| `manager.startDeviceScan(uuids, options, cb)` | `BleManager.startScan({ services }, onResults, onError)` (sessions can overlap), `useScan()`, `BleManager.scanFor(…)` |
| `device.connect()` + `discoverAllServicesAndCharacteristics()` | `peripheral.connect()` (discovers by default) |
| `readCharacteristicForService(s, c)` → `value` (base64) | `peripheral.read(s, c)` → `Uint8Array` |
| `writeCharacteristicWithResponseForService(s, c, base64)` | `peripheral.write(s, c, bytes)` |
| `writeCharacteristicWithoutResponseForService(s, c, base64)` | `peripheral.write(s, c, bytes, { withResponse: false })` |
| `monitorCharacteristicForService(s, c, cb)` | `peripheral.subscribe(s, c, onValue)`, `useCharacteristicValue()` |
| transaction id + `cancelTransaction(id)` | `{ signal }` from an `AbortController` |
| `BleError.errorCode` (number) | `BleError.code` (string, such as `'DISCONNECTED'`) |
