# expo-ble-kit

Bluetooth Low Energy for Expo and React Native apps.

> **Status: preview.** The central role works: scanning, connecting, reading, writing and notifications on iOS and Android. Reconnection policies, background operation and the peripheral role come in later versions. The design and roadmap live in [docs/ARCHITECTURE_AND_PLAN.md](docs/ARCHITECTURE_AND_PLAN.md).

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

## Documentation

- [Getting started](docs/getting-started.md): requirements, install, scanning, connecting, hooks, errors, testing.
- [Permissions](docs/guides/permissions.md): what each platform asks for.
- [Bare React Native setup](docs/guides/bare-setup.md): for apps without prebuild.
- [Troubleshooting](docs/troubleshooting.md): Android status 133, reconnecting by id, location services, the iOS Simulator.
- API reference: `yarn docs` builds it into `docs/api/`.

## Why expo-ble-kit

- **Expo-first:** an Expo module with a config plugin. Works in development builds and in bare React Native apps with `expo` installed (not in Expo Go).
- **Reliable by design:** one GATT operation at a time per connection, a timeout on every operation, typed errors, `AbortSignal` support.
- **Binary-first:** `Uint8Array` end to end, no base64.
- **React hooks:** `useBleState`, `useBlePermissions`, `useScan`, `usePeripheral`, `useCharacteristicValue`.
- **Testable:** `expo-ble-kit/testing` gives app tests virtual peripherals that behave like real ones.

## Requirements

Expo SDK 57+ (Expo Modules 1.0 API), iOS 16.4+, Android 8.0 (API 26)+, New Architecture.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Ahmed Sbai
