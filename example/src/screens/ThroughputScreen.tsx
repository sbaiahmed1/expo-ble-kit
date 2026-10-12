import { useState } from 'react';
import { Platform, StyleSheet, Switch, Text, View } from 'react-native';

import { BleError, BleManager, type Peripheral } from 'expo-ble-kit';

import { TestProfile } from '../lib/gattNames';
import {
  describeTransfer,
  kilobytesPerSecond,
  runAll,
  type TransferName,
  type TransferResult,
} from '../lib/throughput';
import { ActionButton, BluetoothGate, Card, colors, text } from '../ui';

const LABELS: Record<TransferName, string> = {
  writeWithoutResponse: 'Write without response · 1 MiB',
  writeWithResponse: 'Write with response · 256 KiB',
  notifications: 'Notifications · 1000 Hz, batched',
  notificationsUnbatched: 'Notifications · 1000 Hz, one event each',
};

/**
 * P2-08 Throughput: the transfers of docs/benchmarks.md against the test peripheral. The native
 * reference apps print the same lines; compare release builds on the same phone. On Android, the
 * switch asks for the 2M PHY and a high connection priority first (P5-02), for the difference.
 */
export function ThroughputScreen() {
  const [status, setStatus] = useState('Runs against the test peripheral (BleKit-Test).');
  const [results, setResults] = useState<TransferResult[]>([]);
  const [running, setRunning] = useState(false);
  const [fastLink, setFastLink] = useState(false);

  const run = async () => {
    setRunning(true);
    setResults([]);
    let device: Peripheral | null = null;
    try {
      setStatus('Looking for the test peripheral…');
      const found = await BleManager.scanFor({ services: [TestProfile.TEST], timeoutMs: 10_000 });
      if (!found) {
        setStatus('No test peripheral found');
        return;
      }
      device = BleManager.getPeripheral(found.id);
      await device.connect();
      let link = `MTU ${device.mtu}`;
      if (fastLink) {
        await device.android.requestConnectionPriority('high');
        const phy = await device.android.setPreferredPhy(['le2m'], ['le2m']);
        link += `, PHY ${phy.tx}/${phy.rx}, high priority`;
      }
      setStatus(`Connected, ${link}. Measuring…`);
      await runAll(device, (result) => setResults((all) => [...all, result]));
      setStatus(`Throughput done, ${link}`);
    } catch (error) {
      const bleError = BleError.fromNative(error);
      setStatus(`${bleError.code}: ${bleError.message}`);
    } finally {
      device?.disconnect().catch(() => {});
      setRunning(false);
    }
  };

  return (
    <View style={styles.screen}>
      <BluetoothGate />
      <Text style={text.title}>Throughput</Text>
      <Text testID="throughput-status" style={text.muted}>
        {status}
      </Text>
      {Platform.OS === 'android' && (
        <View style={styles.option}>
          <Text style={text.muted}>2M PHY and high priority</Text>
          <Switch testID="throughput-fast-link" value={fastLink} onValueChange={setFastLink} />
        </View>
      )}
      <ActionButton
        kind="primary"
        title={running ? 'Measuring…' : 'Run the benchmarks'}
        testID="throughput-run"
        onPress={running ? () => {} : run}
      />
      {results.map((result) => (
        <Card key={result.name} testID={`result-${result.name}`}>
          <Text style={text.heading}>{LABELS[result.name]}</Text>
          <Text style={styles.speed}>{kilobytesPerSecond(result).toFixed(1)} KB/s</Text>
          <Text style={text.muted} selectable>
            {describeTransfer(result)}
          </Text>
        </Card>
      ))}
      <Text style={text.muted}>
        For numbers to compare, run a release build of this app and of the native reference app
        (benchmarks/) on the same phone with the same peripheral. docs/benchmarks.md has the steps.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { gap: 12 },
  option: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  speed: { fontSize: 32, fontWeight: '700', color: colors.accent, fontVariant: ['tabular-nums'] },
});
