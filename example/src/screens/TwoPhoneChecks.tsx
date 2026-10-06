import { useState } from 'react';
import { Button, Text } from 'react-native';

import { BleError } from 'expo-ble-kit';

import { describeSuite, runTwoPhoneSuite, type SuiteCheck } from '../lib/twoPhoneSuite';
import { checkStyles as styles, Group } from './checksUi';

// P4-05: phone A runs the two-phone suite against phone B, which has the Peripheral tab switched on
// (or against any test peripheral). P4-02's acceptance is the 10-minute run.

export function TwoPhoneChecks() {
  const [status, setStatus] = useState('');
  const [checks, setChecks] = useState<SuiteCheck[]>([]);
  const [running, setRunning] = useState(false);

  async function run(streamSeconds: number) {
    if (running) return;
    setRunning(true);
    setChecks([]);
    setStatus(`Running, with a ${streamSeconds} s stream…`);
    try {
      const report = await runTwoPhoneSuite({
        streamSeconds,
        onCheck: (check) => setChecks((done) => [...done, check]),
      });
      setStatus(describeSuite(report));
    } catch (error) {
      const bleError = BleError.fromNative(error);
      setStatus(`Two-phone suite FAILED: ${bleError.code}: ${bleError.message}`);
    } finally {
      setRunning(false);
    }
  }

  return (
    <Group name="Two-phone suite">
      <Text style={styles.result}>The other phone: Peripheral tab, switched on.</Text>
      <Button
        testID="two-phone-run"
        title="Run the two-phone suite (10 s stream)"
        onPress={() => {
          run(10);
        }}
      />
      <Button
        testID="two-phone-run-long"
        title="Run it with a 10-minute stream"
        onPress={() => {
          run(600);
        }}
      />
      <Text testID="two-phone-status" style={styles.result}>
        {status}
      </Text>
      <Text testID="two-phone-checks" style={styles.result}>
        {checks.map((check) => `${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`).join('\n')}
      </Text>
    </Group>
  );
}
