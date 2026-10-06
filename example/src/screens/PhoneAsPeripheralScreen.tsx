import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';

import {
  BleError,
  BleManager,
  type Advertisement,
  type GattServer,
  type Subscription,
} from 'expo-ble-kit';

import { serverAdvertisement, serverServices, serveTestProfile } from '../lib/serverProfile';
import { colors } from '../ui';

// P4-05: the phone as the test peripheral. It publishes the TEST and Heart Rate services and
// advertises them, so another phone's Explorer, Heart Rate tab and two-phone suite (Checks) use it
// like the Bumble peripheral or the nRF52840.

const time = () => new Date().toISOString().slice(11, 19);

type Running = { server: GattServer; handlers: Subscription[]; advertisement: Advertisement };

export function PhoneAsPeripheralScreen() {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Off');
  const [centrals, setCentrals] = useState<string[]>([]);
  const [requests, setRequests] = useState<string[]>([]);
  const running = useRef<Running | null>(null);

  async function stop() {
    const current = running.current;
    running.current = null;
    current?.handlers.forEach((handler) => handler.remove());
    await current?.advertisement.stop().catch(() => {});
    await current?.server.close().catch(() => {});
  }

  useEffect(() => () => void stop(), []);

  async function start() {
    let server: GattServer | null = null;
    let handlers: Subscription[] = [];
    try {
      await BleManager.requestPermissionsAsync({ connect: true, advertise: true });
      server = await BleManager.openGattServer(serverServices);
      handlers = serveTestProfile(
        server,
        (line) => setRequests((lines) => [`${time()} ${line}`, ...lines].slice(0, 8)),
        (central) => setCentrals((seen) => (seen.includes(central) ? seen : [...seen, central]))
      );
      const advertisement = await BleManager.startAdvertising(serverAdvertisement);
      running.current = { server, handlers, advertisement };
      setStatus('Advertising as the test peripheral');
    } catch (error) {
      handlers.forEach((handler) => handler.remove());
      await server?.close().catch(() => {});
      const bleError = BleError.fromNative(error);
      setStatus(`${bleError.code}: ${bleError.message}`);
      setOn(false);
    }
  }

  async function toggle(value: boolean) {
    setOn(value);
    setBusy(true);
    if (value) {
      setStatus('Starting…');
      setCentrals([]);
      setRequests([]);
      await start();
    } else {
      await stop();
      setStatus('Off');
    }
    setBusy(false);
  }

  return (
    <View style={styles.root}>
      <View style={styles.row}>
        <View style={styles.text}>
          <Text style={styles.title}>Act as the test peripheral</Text>
          <Text style={styles.muted}>
            Another phone finds this one by the TEST service: Explorer, Heart Rate, and the
            two-phone suite under Checks.
          </Text>
        </View>
        <Switch
          testID="peripheral-switch"
          value={on}
          disabled={busy}
          onValueChange={(value) => {
            toggle(value);
          }}
        />
      </View>
      <Text testID="peripheral-status" style={styles.status}>
        {status}
      </Text>
      <Text testID="peripheral-centrals" style={styles.muted}>
        {centrals.length === 0
          ? 'No central yet'
          : `Centrals: ${centrals.map((id) => id.slice(-5)).join(', ')}`}
      </Text>
      <Text testID="peripheral-requests" style={styles.log}>
        {requests.join('\n')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  text: { flex: 1, gap: 4 },
  title: { fontSize: 18, fontWeight: '600', color: colors.ink },
  muted: { fontSize: 13, color: colors.muted },
  status: { fontSize: 15, fontWeight: '600', color: colors.ink },
  log: { fontSize: 12, fontFamily: 'Courier', color: colors.ink },
});
