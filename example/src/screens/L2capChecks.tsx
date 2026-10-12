import { useState } from 'react';
import { Button, Text } from 'react-native';

import { BleError, BleManager, type Peripheral } from 'expo-ble-kit';

import { TestProfile } from '../lib/gattNames';
import { describeEcho, runL2capEcho } from '../lib/l2capEcho';
import { checkStyles as styles, Group } from './checksUi';

// P5-03: 1 MB each way over an L2CAP channel to the test peripheral's echo server: the Bumble
// peripheral, or another phone's Peripheral tab (Android 10+ or iOS on both sides).

export function L2capChecks() {
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  async function echo() {
    let device: Peripheral | null = null;
    setBusy(true);
    try {
      setStatus('Looking for the test peripheral…');
      const found = await BleManager.scanFor({ services: [TestProfile.TEST], timeoutMs: 10_000 });
      if (!found) return setStatus('No test peripheral found');
      device = BleManager.getPeripheral(found.id);
      await device.connect();
      setStatus('Echoing 1 MB over L2CAP…');
      setStatus(describeEcho(await runL2capEcho(device)));
    } catch (error) {
      const bleError = BleError.fromNative(error);
      setStatus(`${bleError.code}: ${bleError.message}`);
    } finally {
      device?.disconnect().catch(() => {});
      setBusy(false);
    }
  }

  return (
    <Group name="L2CAP">
      <Button
        testID="l2cap-echo"
        title="Echo 1 MB over L2CAP"
        disabled={busy}
        onPress={() => {
          echo();
        }}
      />
      <Text testID="l2cap-status" style={styles.result}>
        {status}
      </Text>
    </Group>
  );
}
