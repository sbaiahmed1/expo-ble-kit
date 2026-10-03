import { useEffect, useRef, useState } from 'react';
import { Button, PermissionsAndroid, Platform, Text } from 'react-native';

import { BleError, BleManager } from 'expo-ble-kit';

import { checkStyles as styles, Group } from './checksUi';

// P3-03: keepAliveInBackground on Android. A connect to a device that isn't there stays pending
// (no timeout), so the foreground service runs until "Disconnect". "Connect from the background"
// checks a start Android 12+ refuses (e2e/maestro/keep-alive-background-start.sh): the connect
// fires at the first scan result 15 s after the tap, because JS timers pause in the background
// while scan results still arrive. (A Bluetooth broadcast wouldn't do: Android lets an app start a
// foreground service for 10 s after one.) The log then gets a FOREGROUND_SERVICE_FAILED warning.

const KEEP_ALIVE_ID =
  Platform.OS === 'android' ? 'C0:FF:EE:00:00:97' : '0C6C0000-0000-4000-8000-000000000097';

export function KeepAliveChecks() {
  const [status, setStatus] = useState('');
  const armed = useRef<{ stop(): void } | null>(null);
  const device = BleManager.getPeripheral(KEEP_ALIVE_ID);
  useEffect(() => () => armed.current?.stop(), []);

  async function report(action: string) {
    const diagnostics = await BleManager.getDiagnostics();
    const service = diagnostics.android?.foregroundService;
    setStatus(
      `${action}; state ${device.state}, foreground service ` +
        `${service === undefined ? 'n/a' : service ? 'running' : 'stopped'}`
    );
  }

  function connect(action: string) {
    device.connect({ timeoutMs: null, keepAliveInBackground: true }).then(
      () => report(`${action}: connected`),
      (error) => report(`${action}: ${BleError.fromNative(error).code}`)
    );
    // The connect stays pending; the service starts with it.
    setTimeout(() => report(action), 500);
  }

  function connectFromBackground() {
    armed.current?.stop();
    const armedAt = Date.now();
    setStatus('Keep-alive connect in 15 s, at a scan result: leave the app');
    const scan = BleManager.startScan({}, () => {
      if (Date.now() - armedAt < 15_000 || armed.current !== scan) return;
      scan.stop();
      armed.current = null;
      connect('Keep-alive connect from the background');
    });
    armed.current = scan;
  }

  async function disconnect() {
    armed.current?.stop();
    armed.current = null;
    await device.disconnect();
    await report('Disconnected');
  }

  async function notifications() {
    if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
      const result = await PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS');
      setStatus(`Notifications: ${result}`);
    }
  }

  function setNotification() {
    BleManager.android.setForegroundServiceNotification({
      title: 'expo-ble-kit example',
      text: `Waiting for ${KEEP_ALIVE_ID}`,
    });
    report('Notification set');
  }

  return (
    <Group name="Keep alive">
      <Text testID="keep-alive-status" style={styles.result}>
        {status}
      </Text>
      <Button
        testID="keep-alive-connect"
        title="Keep-alive connect (absent, no timeout)"
        onPress={() => connect('Keep-alive connect')}
      />
      <Button
        testID="keep-alive-from-background"
        title="Keep-alive connect from the background (in 15 s)"
        onPress={connectFromBackground}
      />
      <Button testID="keep-alive-disconnect" title="Disconnect" onPress={disconnect} />
      <Button
        testID="keep-alive-notification"
        title="Set the notification text"
        onPress={setNotification}
      />
      <Button
        testID="keep-alive-permission"
        title="Allow notifications (Android 13+)"
        onPress={notifications}
      />
      <Button testID="keep-alive-refresh" title="Refresh" onPress={() => report('Status')} />
    </Group>
  );
}
