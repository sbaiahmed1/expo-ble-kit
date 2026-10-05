import { useEffect, useRef, useState } from 'react';
import { Button, Text } from 'react-native';

import { BleError, BleManager, type GattServer } from 'expo-ble-kit';

import { serverServices, serveTestProfile } from '../lib/serverProfile';
import { checkStyles as styles, Group } from './checksUi';

// P4-01: the phone as a GATT server with the test profile's TEST service. Centrals find it through
// advertising (P4-03); until then a central that knows the phone's address can connect.

const time = () => new Date().toISOString().slice(14, 23);

export function ServerChecks() {
  const [status, setStatus] = useState('');
  const [requests, setRequests] = useState<string[]>([]);
  const server = useRef<GattServer | null>(null);
  useEffect(() => () => void server.current?.close(), []);

  async function open() {
    if (server.current) return;
    try {
      const opened = await BleManager.openGattServer(serverServices);
      server.current = opened;
      serveTestProfile(opened, (line) => setRequests((lines) => [`${time()} ${line}`, ...lines].slice(0, 10)));
      setStatus(`Server open: TEST service, ${serverServices[0].characteristics.length} characteristics`);
    } catch (error) {
      const bleError = BleError.fromNative(error);
      setStatus(`Server: ${bleError.code}: ${bleError.message}`);
    }
  }

  async function close() {
    await server.current?.close();
    server.current = null;
    setStatus('Server closed');
  }

  return (
    <Group name="GATT server">
      <Text testID="server-status" style={styles.result}>
        {status}
      </Text>
      <Button
        testID="server-open"
        title="Open the test GATT server"
        onPress={() => {
          open();
        }}
      />
      <Button
        testID="server-close"
        title="Close it"
        onPress={() => {
          close();
        }}
      />
      <Text testID="server-requests" style={styles.result}>
        {requests.join('\n')}
      </Text>
    </Group>
  );
}
