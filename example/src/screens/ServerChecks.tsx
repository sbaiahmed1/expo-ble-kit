import { useEffect, useRef, useState } from 'react';
import { Button, Text } from 'react-native';

import {
  BleError,
  BleManager,
  type Advertisement,
  type GattServer,
  type Subscription,
} from 'expo-ble-kit';

import { serverAdvertisement, serverServices, serveTestProfile } from '../lib/serverProfile';
import { checkStyles as styles, Group } from './checksUi';

// P4-01 … P4-03: the phone as a GATT server with the test profile's TEST service, CONTROL streaming
// included, advertising the TEST service so a second phone (or e2e/macos-central) finds it and runs
// the central checks against it.

const time = () => new Date().toISOString().slice(14, 23);

export function ServerChecks() {
  const [status, setStatus] = useState('');
  const [requests, setRequests] = useState<string[]>([]);
  const server = useRef<GattServer | null>(null);
  const handlers = useRef<Subscription[]>([]);
  const advertisement = useRef<Advertisement | null>(null);
  const [advertising, setAdvertising] = useState('');
  useEffect(
    () => () => {
      handlers.current.forEach((handler) => handler.remove());
      void server.current?.close();
      void advertisement.current?.stop();
    },
    []
  );

  async function advertise() {
    if (advertisement.current) return;
    try {
      await BleManager.requestPermissionsAsync({ advertise: true });
      advertisement.current = await BleManager.startAdvertising(serverAdvertisement);
      setAdvertising('Advertising the TEST service');
    } catch (error) {
      const bleError = BleError.fromNative(error);
      setAdvertising(`Advertising: ${bleError.code}: ${bleError.message}`);
    }
  }

  async function stopAdvertising() {
    await advertisement.current?.stop();
    advertisement.current = null;
    setAdvertising('Not advertising');
  }

  async function open() {
    if (server.current) return;
    try {
      const opened = await BleManager.openGattServer(serverServices);
      server.current = opened;
      handlers.current = serveTestProfile(opened, (line) =>
        setRequests((lines) => [`${time()} ${line}`, ...lines].slice(0, 10))
      );
      setStatus(
        `Server open: TEST service, ${serverServices[0].characteristics.length} characteristics`
      );
    } catch (error) {
      const bleError = BleError.fromNative(error);
      setStatus(`Server: ${bleError.code}: ${bleError.message}`);
    }
  }

  async function close() {
    handlers.current.forEach((handler) => handler.remove());
    handlers.current = [];
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
      <Text testID="advertising-status" style={styles.result}>
        {advertising}
      </Text>
      <Button
        testID="advertising-start"
        title="Advertise the TEST service"
        onPress={() => {
          advertise();
        }}
      />
      <Button
        testID="advertising-stop"
        title="Stop advertising"
        onPress={() => {
          stopAdvertising();
        }}
      />
      <Text testID="server-requests" style={styles.result}>
        {requests.join('\n')}
      </Text>
    </Group>
  );
}
