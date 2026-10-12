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
