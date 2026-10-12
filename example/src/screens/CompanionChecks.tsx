import * as TaskManager from 'expo-task-manager';
import { useEffect, useState } from 'react';
import { Button, Platform, Text } from 'react-native';

import { BleError, BleManager } from 'expo-ble-kit';

import { PRESENCE_TASK, type PresenceChange, watchPresence } from '../background/presenceTask';
import { TestProfile } from '../lib/gattNames';
import { checkStyles as styles, Group } from './checksUi';

// P5-05: CompanionDeviceManager (S-B5). Associate the test peripheral through Android's picker,
// register the presence task, then take the peripheral out of range (stop e2e/macos-peripheral)
// and back: Android binds the presence service, which starts the app headless if needed, and the
// task logs "BleKit presence task" in Logcat.

export function CompanionChecks() {
  const [status, setStatus] = useState('');
  const [changes, setChanges] = useState<PresenceChange[]>([]);
  useEffect(() => watchPresence(setChanges), []);

  if (Platform.OS !== 'android') return null;

  async function run(action: string, work: () => Promise<string>) {
    try {
      const result = await work();
      const registered = await TaskManager.isTaskRegisteredAsync(PRESENCE_TASK);
      setStatus(`${action}: ${result}; presence task ${registered ? 'registered' : 'not registered'}`);
    } catch (error) {
      const bleError = BleError.fromNative(error);
      setStatus(`${action}: ${bleError.code}: ${bleError.message}`);
    }
  }

  return (
    <Group name="Companion device (Android)">
      <Text testID="companion-status" style={styles.result}>
        {status}
      </Text>
      <Text testID="companion-presence" style={styles.result}>
        {changes.length
          ? changes
              .slice(0, 5)
              .map(
                (c) =>
                  `${new Date(c.at).toISOString().slice(11, 19)} ${c.id} ${c.present ? 'in range' : 'gone'}`
              )
              .join('\n')
          : 'No presence change in this process yet'}
      </Text>
      <Button
        testID="companion-associate"
        title="Associate: TEST service"
        onPress={() =>
          run('Associate', async () => {
            const device = await BleManager.android.associateCompanionDevice({
              services: [TestProfile.TEST],
            });
            return device ? `associated ${device.id}` : 'nothing picked';
          })
        }
      />
      <Button
        testID="companion-register"
        title="Register the presence task"
        onPress={() =>
          run('Register', async () => {
            await BleManager.registerBackgroundTask(PRESENCE_TASK, { events: ['devicePresence'] });
            return 'ok';
          })
        }
      />
      <Button
        testID="companion-unregister"
        title="Unregister"
        onPress={() =>
          run('Unregister', async () => {
            await BleManager.unregisterBackgroundTask(PRESENCE_TASK);
            return 'ok';
          })
        }
      />
      <Button
        testID="companion-location"
        title="Location services on?"
        onPress={() =>
          run('Location services', async () =>
            String(await BleManager.android.isLocationServicesEnabled())
          )
        }
      />
    </Group>
  );
}
