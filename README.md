# expo-ble-kit

Bluetooth Low Energy for Expo and React Native apps.

> **Status: pre-alpha. Not usable yet.** The design and roadmap live in [docs/ARCHITECTURE_AND_PLAN.md](docs/ARCHITECTURE_AND_PLAN.md). The first preview, `0.1.0` on the `next` dist-tag, ships at the end of phase P1 (central role).

## Goals

- **Expo-first:** an Expo module with a config plugin. Works in development builds and in bare React Native apps with `expo` installed (not in Expo Go).
- **Complete central role:** scan, connect, discover, read, write, notify/indicate, descriptors, MTU, RSSI, several devices at once.
- **Peripheral role:** advertising and a GATT server.
- **Reliable by design:** one queued GATT operation at a time per connection, timeouts everywhere, typed errors, reconnection policies.
- **Binary-first:** `Uint8Array` end to end, no base64.
- **Background support:** iOS state restoration, Android foreground service and background scans, delivered through `expo-task-manager`.
- **Testable:** a public fake adapter for app tests, plus emulator and hardware test suites.

## Requirements (planned)

Expo SDK 58+ (decided after the P0-04 spike), iOS 16.4+, Android 8.0 (API 26)+, New Architecture.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Ahmed Sbai
