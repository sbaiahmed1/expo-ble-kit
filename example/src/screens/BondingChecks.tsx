import { useState } from 'react';
import { Button, Platform, Text } from 'react-native';

import { BleError, BleManager, type Peripheral } from 'expo-ble-kit';

import { toUtf8 } from '../lib/bytes';
import { TestProfile } from '../lib/gattNames';
import { checkStyles as styles, Group } from './checksUi';

// P5-01: pairing with the test peripheral (or a phone acting as one, Peripheral tab). Reading
// SECURE needs an encrypted link: iOS and Android pair by themselves, after asking the user.
// Android can also bond first with createBond().

export function BondingChecks() {
  const [status, setStatus] = useState('');

  async function withTestPeripheral(run: (device: Peripheral) => Promise<string>) {
    let device: Peripheral | null = null;
    try {
      setStatus('Looking for the test peripheral…');
      const found = await BleManager.scanFor({ services: [TestProfile.TEST], timeoutMs: 10_000 });
      if (!found) return setStatus('No test peripheral found');
      device = BleManager.getPeripheral(found.id);
      await device.connect();
      setStatus(`Connected, bond ${device.android.bondState}…`);
      setStatus(await run(device));
    } catch (error) {
      const bleError = BleError.fromNative(error);
      setStatus(`${bleError.code}: ${bleError.message}`);
    } finally {
      device?.disconnect().catch(() => {});
    }
  }

  const readSecure = () =>
    withTestPeripheral(async (device) => {
      const value = await device.read(TestProfile.TEST, TestProfile.SECURE, { timeoutMs: 30_000 });
      return `SECURE read: "${toUtf8(value)}"${Platform.OS === 'android' ? `, bond ${device.android.bondState}` : ''}`;
    });

  const createBond = () =>
    withTestPeripheral(async (device) => {
      await device.android.createBond();
      return `Bonded: bond ${device.android.bondState}`;
    });

  return (
    <Group name="Bonding">
      <Text style={styles.result}>Pairing asks the user on both devices.</Text>
      <Button
        testID="bonding-read-secure"
        title="Read SECURE (pairs if needed)"
        onPress={() => {
          readSecure();
        }}
      />
      {Platform.OS === 'android' && (
        <Button
          testID="bonding-create"
          title="Android: createBond()"
          onPress={() => {
            createBond();
          }}
        />
      )}
      <Text testID="bonding-status" style={styles.result}>
        {status}
      </Text>
    </Group>
  );
}
