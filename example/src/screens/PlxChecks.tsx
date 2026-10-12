import { useState } from 'react';
import { Button, Text } from 'react-native';

import { runPlxSample } from '../lib/plxSample';
import { checkStyles as styles, Group } from './checksUi';

// P6-01: ble-plx app code running on expo-ble-kit through expo-ble-kit/compat/plx, against the test
// peripheral (another phone's Peripheral tab, the Bumble peripheral, or e2e/macos-peripheral).

export function PlxChecks() {
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setLines([]);
    const log = (line: string) => setLines((current) => [...current, line]);
    try {
      await runPlxSample(log);
      log('Done');
    } catch (error) {
      log(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Group name="ble-plx compatibility">
      <Button
        testID="plx-sample"
        title="Run the ble-plx sample"
        disabled={busy}
        onPress={() => {
          run();
        }}
      />
      <Text testID="plx-log" style={styles.result}>
        {lines.join('\n')}
      </Text>
    </Group>
  );
}
