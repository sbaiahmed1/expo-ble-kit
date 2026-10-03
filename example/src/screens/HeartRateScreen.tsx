import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  GattCharacteristics,
  GattServices,
  useCharacteristicValue,
  usePeripheral,
  useScan,
  type BleError,
  type ConnectionState,
  type Peripheral,
} from 'expo-ble-kit';

import { TestProfile } from '../lib/gattNames';
import { parseHeartRateMeasurement } from '../lib/heartRate';
import { ActionButton, BluetoothGate, Card, Chip, colors, text } from '../ui';

const HISTORY = 40;

// After a lost link the library tries again after 1, 2, 4, 8 and 16 s, then gives up.
const RECONNECT = { maxAttempts: 5 };

/** `failure`: why the last connection failed or ended, when the user didn't stop it. */
function statusLine(state: ConnectionState, failure: BleError | null): string {
  switch (state) {
    case 'connecting':
      return 'Connecting…';
    case 'connected':
      return 'Connected';
    case 'reconnecting':
      return 'Connection lost. Reconnecting…';
    case 'disconnecting':
      return 'Disconnecting…';
    case 'disconnected':
      return failure ? `Not connected: ${failure.code}` : 'Not connected';
  }
}

/** How many times the link came back by itself after it was lost. */
function useReconnectCount(peripheral: Peripheral | null): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!peripheral) return;
    let lost = false;
    const listener = peripheral.addConnectionStateListener((state) => {
      if (state === 'connected' && lost) setCount((n) => n + 1);
      lost = state === 'reconnecting';
    });
    return () => listener.remove();
  }, [peripheral]);
  return count;
}

/** Heart-rate monitors nearby: anything advertising the Heart Rate service (0x180D). */
function MonitorPicker(props: { onPick: (id: string) => void }) {
  const { results, isScanning, error } = useScan({ services: [GattServices.HeartRate] });
  return (
    <View style={styles.screen}>
      <Text style={text.title}>Heart rate</Text>
      <Text testID="hr-scan-status" style={text.muted}>
        {error ? error.code : isScanning ? 'Looking for heart rate monitors…' : 'Not scanning'}
      </Text>
      {results.length === 0 && (
        <Card>
          <Text style={text.body}>
            Put on your strap, or start the test peripheral (BleKit-Test serves Heart Rate too).
          </Text>
        </Card>
      )}
      {results.map((result) => (
        <Pressable
          key={result.id}
          testID={`monitor-${result.id}`}
          accessibilityRole="button"
          accessibilityLabel={result.name ?? result.id}
          onPress={() => props.onPick(result.id)}
          style={({ pressed }) => [styles.monitor, pressed && { opacity: 0.7 }]}>
          <View style={{ flexShrink: 1 }}>
            <Text style={text.heading}>{result.name ?? 'Heart rate monitor'}</Text>
            <Text style={text.muted}>{result.id}</Text>
          </View>
          <Chip label={`${result.rssi} dBm`} />
        </Pressable>
      ))}
    </View>
  );
}

/** The test peripheral's CONTROL characteristic, which can drop the link on request. */
function hasControl(peripheral: Peripheral): boolean {
  return peripheral.services.some(
    (service) =>
      service.uuid === TestProfile.TEST &&
      service.characteristics.some((c) => c.uuid === TestProfile.CONTROL)
  );
}

function Monitor(props: { id: string; onClose: () => void }) {
  const { peripheral, state, error: linkError } = usePeripheral(props.id);
  const [wanted, setWanted] = useState(true);
  const [retryToken, setRetryToken] = useState(0);
  const reconnects = useReconnectCount(peripheral);
  const { value, error } = useCharacteristicValue(
    peripheral,
    GattServices.HeartRate,
    GattCharacteristics.HeartRateMeasurement
  );
  const measurement = value ? parseHeartRateMeasurement(value) : null;
  const [history, setHistory] = useState<number[]>([]);
  const failure = wanted ? linkError : null;

  // The library keeps the link: after a loss it reconnects and restores the subscription (P2-01).
  // A failed first connect shows its error and a Try again button.
  useEffect(() => {
    if (peripheral && wanted) {
      peripheral.connect({ timeoutMs: 10_000, reconnect: RECONNECT }).catch(() => {});
    }
  }, [peripheral, wanted, retryToken]);

  // One entry per notification: each value is a new array.
  useEffect(() => {
    const reading = value ? parseHeartRateMeasurement(value) : null;
    if (reading) setHistory((previous) => [...previous, reading.bpm].slice(-HISTORY));
  }, [value]);

  const stop = () => {
    setWanted(false);
    peripheral?.disconnect().catch(() => {});
  };
  const close = () => {
    stop();
    props.onClose();
  };
  // Asks the test peripheral to disconnect in 0.5 s (CONTROL DISCONNECT_AFTER), to see the reconnection.
  const dropLink = () =>
    peripheral
      ?.write(TestProfile.TEST, TestProfile.CONTROL, Uint8Array.of(0x02, 0xf4, 0x01, 0x00, 0x00))
      .catch(() => {});

  const max = Math.max(1, ...history);
  const min = Math.min(max - 1, ...history);
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <ActionButton compact title="‹ Monitors" testID="hr-back" onPress={close} />
        <Text style={text.muted}>{peripheral?.name ?? props.id}</Text>
      </View>
      <Card style={styles.reading}>
        <Text
          testID="bpm"
          style={styles.bpm}
          accessibilityLabel={
            measurement ? `${measurement.bpm} beats per minute` : 'No reading yet'
          }>
          {measurement ? measurement.bpm : '--'}
        </Text>
        <Text style={text.muted}>beats per minute</Text>
        <Text
          testID="hr-status"
          style={[text.body, state === 'reconnecting' && { color: colors.signal }]}>
          {statusLine(state, failure)}
        </Text>
        <View style={styles.chips}>
          {measurement?.sensorContact === false && <Chip label="No skin contact" tone="signal" />}
          {measurement?.sensorContact === true && <Chip label="Skin contact" tone="accent" />}
          {measurement && measurement.rrIntervalsMs.length > 0 && (
            <Chip label={`RR ${measurement.rrIntervalsMs.join(', ')} ms`} />
          )}
          {measurement?.energyExpendedKj != null && (
            <Chip label={`${measurement.energyExpendedKj} kJ`} />
          )}
          {reconnects > 0 && (
            <View testID="hr-reconnects">
              <Chip label={`Reconnected ${reconnects}×`} tone="signal" />
            </View>
          )}
        </View>
        {error && <Text style={styles.error}>{`${error.code}: ${error.message}`}</Text>}
      </Card>
      <Card>
        <Text style={text.heading}>Last {HISTORY} readings</Text>
        <View style={styles.chart} accessibilityLabel={`History of ${history.length} readings`}>
          {history.map((bpm, index) => (
            <View
              key={index}
              style={[styles.bar, { height: 8 + ((bpm - min) / (max - min || 1)) * 72 }]}
            />
          ))}
        </View>
        {history.length > 0 && (
          <Text style={text.muted}>
            {min} – {max} bpm
          </Text>
        )}
      </Card>
      <View style={styles.actions}>
        {wanted ? (
          <ActionButton kind="danger" title="Disconnect" testID="hr-disconnect" onPress={stop} />
        ) : (
          <ActionButton
            kind="primary"
            title="Connect"
            testID="hr-connect"
            onPress={() => setWanted(true)}
          />
        )}
        {state === 'disconnected' && failure && (
          <ActionButton
            title="Try again"
            testID="hr-retry"
            onPress={() => setRetryToken((n) => n + 1)}
          />
        )}
        {state === 'connected' && peripheral && hasControl(peripheral) && (
          <ActionButton title="Drop the link (test device)" testID="hr-drop" onPress={dropLink} />
        )}
      </View>
    </View>
  );
}

/** P1-15 Heart Rate: find a 0x180D monitor, stay connected, show the live BPM. */
export function HeartRateScreen() {
  const [monitor, setMonitor] = useState<string | null>(null);
  return (
    <View style={{ gap: 12 }}>
      <BluetoothGate />
      {monitor ? (
        <Monitor id={monitor} onClose={() => setMonitor(null)} />
      ) : (
        <MonitorPicker onPick={setMonitor} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { gap: 12 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  monitor: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  reading: { alignItems: 'center', paddingVertical: 24 },
  bpm: { fontSize: 72, fontWeight: '700', color: colors.bad, fontVariant: ['tabular-nums'] },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'center' },
  chart: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 84 },
  bar: { flex: 1, borderRadius: 2, backgroundColor: colors.bad, opacity: 0.75 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  error: { fontSize: 12, color: colors.bad },
});
