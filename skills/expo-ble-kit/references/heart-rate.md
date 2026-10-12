# Recipe: a heart rate monitor

A screen that finds a heart-rate strap (any device with the standard Heart Rate service, 0x180D), connects, shows the beats per minute live, and comes back by itself when the strap drops out of range. Then a Jest test with the fake.

## 1. Config

```json
{ "expo": { "plugins": [["expo-ble-kit", { "bluetoothAlwaysPermission": "Allow $(PRODUCT_NAME) to read your heart rate strap." }]] } }
```

Rebuild the app after adding the plugin (`npx expo run:ios` / `run:android`).

## 2. Parse the Heart Rate Measurement (0x2A37)

The value is a flags byte, then the rate, then optional fields (Bluetooth SIG Heart Rate Service):

| Bit of `flags` | Meaning |
| --- | --- |
| 0 | 0: the rate is one byte (uint8); 1: two bytes, little-endian (uint16) |
| 1–2 | Sensor contact: `0b11` contact detected, `0b10` supported but no contact, `0b0x` not supported |
| 3 | Energy expended present: a uint16 in kilojoules after the rate |
| 4 | RR intervals present: the rest of the value is uint16s in 1/1024 s |

```ts
export type HeartRate = {
  bpm: number;
  /** null when the strap doesn't report skin contact. */
  contact: boolean | null;
  energyKj: number | null;
  /** Beat-to-beat intervals in milliseconds. */
  rrMs: number[];
};

export function parseHeartRate(value: Uint8Array): HeartRate {
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const flags = view.getUint8(0);
  let offset = 1;
  const wide = (flags & 0x01) !== 0;
  const bpm = wide ? view.getUint16(offset, true) : view.getUint8(offset);
  offset += wide ? 2 : 1;
  const contactBits = (flags >> 1) & 0x03;
  const contact = contactBits & 0x02 ? contactBits === 0x03 : null;
  let energyKj: number | null = null;
  if (flags & 0x08) {
    energyKj = view.getUint16(offset, true);
    offset += 2;
  }
  const rrMs: number[] = [];
  if (flags & 0x10) {
    for (; offset + 1 < value.byteLength; offset += 2) {
      rrMs.push(Math.round((view.getUint16(offset, true) * 1000) / 1024));
    }
  }
  return { bpm, contact, energyKj, rrMs };
}
```

Always build the `DataView` with `byteOffset` and `byteLength`: a `Uint8Array` may be a view into a larger buffer.

## 3. The screen

```tsx
import { useEffect, useState } from 'react';
import { Button, Text, View } from 'react-native';
import {
  BleError,
  BleManager,
  GattCharacteristics,
  GattServices,
  useBleState,
  useCharacteristicValue,
  usePeripheral,
} from 'expo-ble-kit';

import { parseHeartRate } from './parseHeartRate';

export function HeartRateScreen() {
  const bluetooth = useBleState();
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [status, setStatus] = useState('Tap Find to look for a strap');
  const { peripheral, state } = usePeripheral(deviceId);
  // Subscribes whenever the strap is connected, again after a reconnection; keeps the last value.
  const { value, error } = useCharacteristicValue(
    peripheral,
    GattServices.HeartRate,
    GattCharacteristics.HeartRateMeasurement
  );
  const reading = value ? parseHeartRate(value) : null;

  async function find() {
    try {
      const permissions = await BleManager.requestPermissionsAsync();
      if (permissions.scan !== 'granted' || permissions.connect !== 'granted') {
        setStatus('Bluetooth permission is needed');
        return;
      }
      setStatus('Looking for a strap…');
      const found = await BleManager.scanFor({ services: [GattServices.HeartRate], timeoutMs: 15_000 });
      if (!found) {
        setStatus('No strap found: wear it (most only advertise with skin contact) and try again');
        return;
      }
      setStatus(`Connecting to ${found.name ?? found.id}…`);
      setDeviceId(found.id);
      // Comes back by itself after a drop: waits 1, 2, 4… up to 30 s between attempts, no limit.
      await BleManager.getPeripheral(found.id).connect({ reconnect: {} });
      setStatus('Connected');
    } catch (e) {
      setStatus(`${BleError.fromNative(e).code}: ${BleError.fromNative(e).message}`);
    }
  }

  // Disconnect when the screen goes away.
  useEffect(() => () => void peripheral?.disconnect().catch(() => {}), [peripheral]);

  return (
    <View style={{ padding: 24, gap: 12 }}>
      <Text>Bluetooth: {bluetooth}</Text>
      <Text>{status}</Text>
      <Text>Connection: {state}</Text>
      <Text style={{ fontSize: 64 }}>{reading ? reading.bpm : '--'} bpm</Text>
      {reading?.contact === false && <Text>No skin contact</Text>}
      {error && <Text>{error.code}</Text>}
      {/* Not gated on poweredOn: before permission the state is unknown (iOS) or unauthorized
          (Android 12+), and this button is what asks for it. */}
      <Button
        title="Find a strap"
        testID="find-strap"
        onPress={() => void find()}
        disabled={bluetooth === 'poweredOff' || bluetooth === 'unsupported'}
      />
      {peripheral && (
        <Button title="Disconnect" onPress={() => void peripheral.disconnect().catch(() => {})} />
      )}
    </View>
  );
}
```

Without hooks, the same subscription is:

```ts
const strap = BleManager.getPeripheral(id);
await strap.connect({ reconnect: {} });
const subscription = await strap.subscribe(
  GattServices.HeartRate,
  GattCharacteristics.HeartRateMeasurement,
  (value) => console.log(parseHeartRate(value).bpm)
);
// later
subscription.remove();
await strap.disconnect();
```

Battery level, when the strap has the Battery service: `useCharacteristicValue(peripheral, GattServices.Battery, GattCharacteristics.BatteryLevel, { mode: 'read' })`, whose `value[0]` is the percentage.

To reconnect at the next app start, save `found.id` (for example with `expo-secure-store` or AsyncStorage) and call `BleManager.getPeripheral(savedId).connect({ timeoutMs: null, reconnect: {} })`: with `timeoutMs: null` the connect waits until the strap is in range. Ids are per platform and per install on iOS.

## 4. Test it with the fake

```tsx
import { act, render, screen, fireEvent } from '@testing-library/react-native';
import { GattCharacteristics, GattServices } from 'expo-ble-kit';
import { installFakeBle, type FakeBle } from 'expo-ble-kit/testing';

import { HeartRateScreen } from './HeartRateScreen';
import { parseHeartRate } from './parseHeartRate';

const settle = () => act(() => jest.advanceTimersByTimeAsync(100));

describe('HeartRateScreen', () => {
  let ble: FakeBle;

  beforeEach(() => {
    jest.useFakeTimers();
    ble = installFakeBle(); // powered on, permissions granted
  });

  afterEach(() => jest.useRealTimers());

  it('shows the strap’s heart rate', async () => {
    const strap = ble.addPeripheral({
      name: 'HRM',
      services: [
        {
          uuid: GattServices.HeartRate,
          characteristics: [{ uuid: GattCharacteristics.HeartRateMeasurement, properties: ['notify'] }],
        },
      ],
    });
    await render(<HeartRateScreen />); // Testing Library 14: render and fireEvent are async
    await settle();
    await fireEvent.press(screen.getByTestId('find-strap'));
    await settle(); // scan
    await settle(); // connect and discovery
    await settle(); // the hook subscribes once connected
    expect(strap.isNotifying(GattServices.HeartRate, GattCharacteristics.HeartRateMeasurement)).toBe(true);
    // The fake delivers the value at once: inside act, like any state change from a test.
    await act(async () =>
      strap.notify(GattServices.HeartRate, GattCharacteristics.HeartRateMeasurement, Uint8Array.of(0x06, 72))
    );
    expect(screen.getByText('72 bpm')).toBeTruthy();
  });

  it('parses a 16-bit rate, energy and RR intervals', () => {
    expect(parseHeartRate(Uint8Array.of(0x19, 0x2c, 0x01, 0x10, 0x00, 0x00, 0x04))).toEqual({
      bpm: 300,
      contact: null,
      energyKj: 16,
      rrMs: [1000],
    });
  });
});
```

`strap.disconnect('linkLoss')` simulates walking out of range (the screen shows `reconnecting`, then `connected` again while the strap still advertises); `strap.advertise(false)` keeps it away; `ble.setState('poweredOff')` turns Bluetooth off.
