# expo-ble-kit

Bluetooth Low Energy for Expo and React Native apps: the phone as a central (scan, connect, read, write, notifications) and as a peripheral (GATT server, advertising).

> **Status: preview.** Versions before 1.0 are published on npm's `next` tag, and the API can still change between minor versions. What has already run on real phones is listed under [Tested on hardware](#tested-on-hardware); the rest is covered by unit tests on both platforms and by the test fake. Design and roadmap: [docs/ARCHITECTURE_AND_PLAN.md](docs/ARCHITECTURE_AND_PLAN.md).

```bash
npx expo install expo-ble-kit@next
```

```ts
import { BleManager, GattCharacteristics, GattServices } from 'expo-ble-kit';

await BleManager.requestPermissionsAsync();

const found = await BleManager.scanFor({ services: [GattServices.HeartRate], timeoutMs: 10_000 });
if (found) {
  const monitor = BleManager.getPeripheral(found.id);
  await monitor.connect();
  await monitor.subscribe(GattServices.HeartRate, GattCharacteristics.HeartRateMeasurement, (value) => {
    const bpm = value[0] & 0x01 ? value[1] | (value[2] << 8) : value[1];
    console.log(bpm, 'bpm');
  });
}
```

## What it does

- **Central:** scanning with filters (several scans share the radio), connections with timeouts, cancellation and reconnection policies, several devices at once, discovery, reads and writes (long ones too), writes without response with flow control, `writeStream` for large payloads, notifications and indications, native batching of fast notifications, MTU and RSSI.
- **Peripheral:** a GATT server (static and dynamic values, long reads served from one value, long writes), notifications with flow control, advertising.
- **Android in the background:** a foreground service that keeps connections open, and background scans that wake the app through `expo-task-manager`. iOS background support comes later.
- **Around it:** a config plugin for permissions and options, typed errors (`BleError` with a `code`), React hooks, logging and diagnostics, and `expo-ble-kit/testing`, a fake Bluetooth stack for Jest.

## Compatibility

| expo-ble-kit | Expo SDK | React Native | iOS | Android |
| --- | --- | --- | --- | --- |
| 0.1.x | 57 | 0.86 | 16.4+ | 8.0 (API 26)+ |

New Architecture only. It needs a development build or a bare React Native app with `expo` installed: Expo Go doesn't include the native code. The iOS Simulator has no Bluetooth.

## Tested on hardware

Debug builds of the example app on a Samsung Galaxy A52 (Android 14) and an iPhone 14 Pro Max (iOS 27):

- **Android:** permissions, Bluetooth turned off and on 50 times during scans and connects, scanning (several sessions, the scan-start throttle, a 45-minute scan), connection timeouts and cancellation, 100 connect/cancel cycles without a leaked GATT client, the keep-alive foreground service, a background scan waking the app after the system killed it, and every example flow in demo mode.
- **iOS:** scanning, connecting to a Mac and reading its Device Information service, RSSI, the error paths; the GATT server with a Mac as the central (reads, 512-byte long reads, long writes, writes without response, a 100 Hz stream without gaps, indications).
- **Not yet on hardware:** transfers against a test peripheral (the nRF52840, or a second phone running the example's Peripheral tab: `e2e/maestro/two-phone.sh`), advertising, and the device matrix of the plan (§8.2).

## Documentation

- [Getting started](docs/getting-started.md): requirements, install, scanning, connecting, sending data, notifications, background (Android), the GATT server, advertising, hooks, errors, testing.
- [Permissions](docs/guides/permissions.md): what each platform asks for.
- [Bare React Native setup](docs/guides/bare-setup.md): for apps without prebuild.
- [Moving from react-native-ble-plx](docs/guides/migration-from-plx.md): `expo-ble-kit/compat/plx` keeps ble-plx's API, so an app moves by changing its imports.
- [Troubleshooting](docs/troubleshooting.md): Android status 133, reconnecting by id, location services, the iOS Simulator.
- [Soak tests](docs/soak.md) and [benchmarks](docs/benchmarks.md): the long runs and the throughput measurements.
- API reference: `yarn docs` builds it into `docs/api/`.
- The example app in `example/`: Explorer, Heart Rate, Throughput, the phone as a test peripheral, and the developer checks.

## Why expo-ble-kit

- **Expo-first:** an Expo module with a config plugin. Works in development builds and in bare React Native apps with `expo` installed.
- **Reliable by design:** one GATT operation at a time per connection, a timeout on every operation, typed errors, `AbortSignal` support.
- **Binary-first:** `Uint8Array` end to end, no base64.
- **React hooks:** `useBleState`, `useBlePermissions`, `useScan`, `usePeripheral`, `useCharacteristicValue`.
- **Testable:** `expo-ble-kit/testing` gives app tests virtual peripherals that behave like real ones, and a virtual central for GATT server code.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Releases: [docs/releasing.md](docs/releasing.md). Report security problems privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Ahmed Sbai
