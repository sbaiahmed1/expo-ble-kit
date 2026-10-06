---
'expo-ble-kit': minor
---

First preview of expo-ble-kit, Bluetooth Low Energy for Expo and React Native. The central role: permissions and adapter state without surprise prompts, scanning with filters (several scans share the radio), connections with timeouts and `AbortSignal` cancellation, service discovery, reads and writes (long ones too), descriptors, notifications and indications, MTU and RSSI, typed errors (`BleError` with a `code`), UUID helpers and constants, the React hooks `useBleState`, `useBlePermissions`, `useScan`, `usePeripheral` and `useCharacteristicValue`, a config plugin for the permissions, and `expo-ble-kit/testing`, a fake Bluetooth stack for Jest. The other entries of this release add to it.
