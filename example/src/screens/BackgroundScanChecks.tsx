import * as TaskManager from 'expo-task-manager';
import { useEffect, useState } from 'react';
import { Button, Text } from 'react-native';

import { BleError, BleManager, type BackgroundTaskOptions } from 'expo-ble-kit';

import { BACKGROUND_SCAN_TASK, type Delivery, watchDeliveries } from '../background/scanTask';
import { TestProfile } from '../lib/gattNames';
import { checkStyles as styles, Group } from './checksUi';

// P3-04: a background scan delivered to a TaskManager task (S-B4). Register it, leave the app, and
// let the system kill it (adb shell am kill expo.modules.blekit.example): a matching advertisement
// starts the app headless and the task logs "BleKit background task" in Logcat.

const FILTERS: Record<'test' | 'apple', BackgroundTaskOptions['scan']> = {
  test: { services: [TestProfile.TEST] },
  // Without a test peripheral: iPhones, Macs and AirPods nearby advertise Apple data all the time.
  apple: { manufacturerData: [{ companyId: 0x004c }] },
};

export function BackgroundScanChecks() {
  const [status, setStatus] = useState('');
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  useEffect(() => watchDeliveries(setDeliveries), []);

  async function run(action: string, work: () => Promise<unknown>) {
    try {
      await work();
      const registered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_SCAN_TASK);
      setStatus(`${action}: ok; task ${registered ? 'registered' : 'not registered'}`);
    } catch (error) {
      const bleError = BleError.fromNative(error);
      setStatus(`${action}: ${bleError.code}: ${bleError.message}`);
    }
  }

  const register = (filter: keyof typeof FILTERS) =>
    run(`Register (${filter})`, () =>
      BleManager.registerBackgroundTask(BACKGROUND_SCAN_TASK, {
        events: ['scanResults'],
        scan: FILTERS[filter],
      })
    );

  return (
    <Group name="Background scan">
      <Text testID="background-scan-status" style={styles.result}>
        {status}
      </Text>
      <Text testID="background-scan-deliveries" style={styles.result}>
        {deliveries.length
          ? deliveries
              .slice(0, 5)
              .map((d) => `${new Date(d.at).toISOString().slice(11, 19)} ${d.count} results`)
              .join('\n')
          : 'No delivery in this process yet'}
      </Text>
      <Button
        testID="background-scan-permission"
        title="Ask for background scanning"
        onPress={() =>
          run('Permission', async () => {
            const permissions = await BleManager.requestPermissionsAsync({ backgroundScan: true });
            if (permissions.backgroundScan !== 'granted') {
              throw new BleError('PERMISSION_DENIED', `backgroundScan ${permissions.backgroundScan}`);
            }
          })
        }
      />
      <Button
        testID="background-scan-test"
        title="Register: TEST service"
        onPress={() => register('test')}
      />
      <Button
        testID="background-scan-apple"
        title="Register: Apple data"
        onPress={() => register('apple')}
      />
      <Button
        testID="background-scan-unregister"
        title="Unregister"
        onPress={() =>
          run('Unregister', () => BleManager.unregisterBackgroundTask(BACKGROUND_SCAN_TASK))
        }
      />
    </Group>
  );
}
