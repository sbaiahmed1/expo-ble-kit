import { BleError, BleManager, type RestorationJournalEntry } from 'expo-ble-kit';
import { useEffect, useState } from 'react';
import { Button, Platform, Text } from 'react-native';


import { checkStyles as styles, Group } from './checksUi';
import { watchRestorationDeliveries, type RestorationDelivery } from '../background/restorationTask';
import { armRestoration } from '../lib/restoration';

// P3-01: state restoration (S-B2). Connect to the test peripheral and keep its 1 Hz Heart Rate
// notifications on, stop the app the way iOS does (e2e/ios-restoration/kill.sh, not the app
// switcher), and the journal shows what iOS did while the app wasn't running.

function describe(entry: RestorationJournalEntry): string {
  const time = new Date(entry.time).toISOString().slice(11, 19);
  return `${time} ${entry.event}${entry.count > 1 ? ` ×${entry.count}` : ''}`;
}

export function RestorationChecks() {
  const [status, setStatus] = useState('');
  const [journal, setJournal] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [deliveries, setDeliveries] = useState<RestorationDelivery[]>([]);
  useEffect(() => watchRestorationDeliveries(setDeliveries), []);

  async function arm() {
    setBusy(true);
    try {
      await armRestoration(setStatus);
    } catch (error) {
      const bleError = BleError.fromNative(error);
      setStatus(`${bleError.code}: ${bleError.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function showJournal() {
    const restoration = (await BleManager.getDiagnostics()).ios?.restoration;
    if (!restoration?.enabled) return setJournal(['Restoration is off in this build']);
    setJournal(restoration.journal.length ? restoration.journal.map(describe) : ['The journal is empty']);
  }

  if (Platform.OS !== 'ios') return null;
  return (
    <Group name="State restoration (iOS)">
      <Button
        testID="restoration-arm"
        title="Connect and keep heart rate on"
        disabled={busy}
        onPress={() => void arm()}
      />
      <Text testID="restoration-status" style={styles.result}>
        {status}
      </Text>
      <Button testID="restoration-journal" title="Show the journal" onPress={() => void showJournal()} />
      <Text testID="restoration-journal-lines" style={styles.result}>
        {journal.join('\n')}
      </Text>
      <Text testID="restoration-task" style={styles.result}>
        {deliveries.length
          ? `The task received ${deliveries.length}, newest first:\n` +
            deliveries
              .slice(0, 8)
              .map((delivery) => delivery.summary)
              .join('\n')
          : 'The task has received nothing in this process'}
      </Text>
    </Group>
  );
}
