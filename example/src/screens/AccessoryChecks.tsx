import { useState } from 'react';
import { Button, Platform, Text } from 'react-native';

import { BleError, BleManager, type Peripheral } from 'expo-ble-kit';

import { TestProfile } from '../lib/gattNames';
import { checkStyles as styles, Group } from './checksUi';

// P5-04: AccessorySetupKit's picker (iOS 18+) for the test peripheral. Only the separate build with
// AccessorySetupKit declared can show it (`EXPO_BLE_KIT_ASK=1`, example/app.config.ts); the normal
// build answers MISCONFIGURED.

/** Reading SECURE pairs: left out. */
const SECURE = TestProfile.SECURE;

export function AccessoryChecks() {
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function pick() {
    setBusy(true);
    setLines([]);
    const log = (line: string) => setLines((current) => [...current, line]);
    let device: Peripheral | null = null;
    try {
      const permissions = await BleManager.getPermissionsAsync();
      log(`Bluetooth permission before: ${permissions.connect}`);
      device = await BleManager.ios.showAccessoryPicker([
        {
          name: 'BleKit test peripheral',
          productImage: require('../../assets/icon.png'),
          service: TestProfile.TEST,
        },
      ]);
      if (!device) return log('Nothing picked');
      log(`Picked ${device.id}`);
      log(`Bluetooth permission after: ${(await BleManager.getPermissionsAsync()).connect}`);
      await device.connect();
      const test = device.services.find((service) => service.uuid === TestProfile.TEST);
      const readable = test?.characteristics.find(
        (characteristic) =>
          characteristic.properties.includes('read') && characteristic.uuid !== SECURE
      );
      log(`Connected: ${device.services.length} services`);
      if (readable) {
        const value = await device.read(TestProfile.TEST, readable.uuid);
        log(
          `Read ${readable.uuid.slice(4, 8)}: ${[...value].map((byte) => byte.toString(16).padStart(2, '0')).join(' ')}`
        );
      }
    } catch (error) {
      const bleError = BleError.fromNative(error);
      log(`${bleError.code}: ${bleError.message}`);
    } finally {
      device?.disconnect().catch(() => {});
      setBusy(false);
    }
  }

  if (Platform.OS !== 'ios') return null;
  return (
    <Group name="Accessory picker (iOS 18+)">
      <Button
        testID="accessory-pick"
        title="Pick the test peripheral"
        disabled={busy}
        onPress={() => {
          pick();
        }}
      />
      <Text testID="accessory-log" style={styles.result}>
        {lines.join('\n')}
      </Text>
    </Group>
  );
}
