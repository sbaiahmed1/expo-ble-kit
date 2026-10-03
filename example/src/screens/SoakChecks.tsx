import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useRef, useState } from 'react';
import { Button, Platform, Text } from 'react-native';

import { BleError, BleManager, type ScanOptions } from 'expo-ble-kit';

import { runningDemo } from '../demo/testPeripheral';
import { TestProfile } from '../lib/gattNames';
import { describeLongScan, describeToggleSoak, runLongScan, runToggleSoak } from '../lib/soak';
import { checkStyles as styles, Group } from './checksUi';

// P2-09 soak suite (plan §8.5, docs/soak.md): Bluetooth toggled off and on during active
// operations, and a 45-minute filtered scan. The 60-minute notification run and the 500 connect
// cycles are in the Test peripheral group.

const LONG_SCAN_FILTERS: Record<'test' | 'apple', { label: string; options: ScanOptions }> = {
  test: { label: 'TEST service', options: { services: [TestProfile.TEST] } },
  // Without a test peripheral: iPhones, Macs and AirPods nearby advertise Apple data all the time.
  apple: { label: 'Apple data', options: { manufacturerData: [{ companyId: 0x004c }] } },
};
const KEEP_AWAKE = 'long-scan';
// The toggle soak's device that isn't there. Not the Connecting group's, whose log would fill up.
const SOAK_ABSENT_ID =
  Platform.OS === 'android' ? 'C0:FF:EE:00:00:98' : '0C6C0000-0000-4000-8000-000000000098';

export function SoakChecks() {
  const [status, setStatus] = useState('');
  const toggleRun = useRef<AbortController | null>(null);
  const scanRun = useRef<AbortController | null>(null);

  async function startToggleSoak() {
    if (toggleRun.current) return;
    const controller = new AbortController();
    toggleRun.current = controller;
    try {
      setStatus('Looking for the test peripheral…');
      const found = await BleManager.scanFor({ services: [TestProfile.TEST], timeoutMs: 5_000 });
      const demo = runningDemo();
      const report = await runToggleSoak({
        absent: BleManager.getPeripheral(SOAK_ABSENT_ID),
        peripheral: found ? BleManager.getPeripheral(found.id) : null,
        signal: controller.signal,
        // Demo mode turns the fake adapter off and on 50 times. On a phone,
        // e2e/soak/bluetooth-toggle.sh does, and checks the number of offs in the report.
        toggle: demo ? (on) => demo.setState(on ? 'poweredOn' : 'poweredOff') : undefined,
        minOffs: demo ? undefined : 1,
        onUpdate: (sofar) => setStatus(describeToggleSoak(sofar, false)),
      });
      setStatus(describeToggleSoak(report));
    } catch (error) {
      setStatus(`Toggle soak FAILED: ${BleError.fromNative(error).code}`);
    } finally {
      toggleRun.current = null;
    }
  }

  function stopToggleSoak() {
    if (!toggleRun.current) return;
    setStatus('Toggle soak: waiting for the operations in flight to settle…');
    toggleRun.current.abort();
  }

  async function longScan(filter: keyof typeof LONG_SCAN_FILTERS) {
    if (scanRun.current) return;
    const controller = new AbortController();
    scanRun.current = controller;
    // The criterion is with the screen on: unfiltered scans pause when it is off.
    await activateKeepAwakeAsync(KEEP_AWAKE).catch(() => {});
    try {
      const report = await runLongScan({
        filter: LONG_SCAN_FILTERS[filter],
        signal: controller.signal,
        onUpdate: (sofar) => setStatus(describeLongScan(sofar, false)),
      });
      setStatus(describeLongScan(report));
    } catch (error) {
      const bleError = BleError.fromNative(error);
      setStatus(`Long scan FAILED: ${bleError.code}: ${bleError.message}`);
    } finally {
      deactivateKeepAwake(KEEP_AWAKE).catch(() => {});
      scanRun.current = null;
    }
  }

  return (
    <Group name="Soak">
      <Text testID="soak-status" style={styles.result}>
        {status}
      </Text>
      <Button
        testID="toggle-soak-start"
        title="Bluetooth toggle soak: start"
        onPress={startToggleSoak}
      />
      <Button
        testID="toggle-soak-stop"
        title="Bluetooth toggle soak: stop and report"
        onPress={stopToggleSoak}
      />
      <Button
        testID="long-scan-test"
        title="Long scan, TEST service, 45 min"
        onPress={() => longScan('test')}
      />
      <Button
        testID="long-scan-apple"
        title="Long scan, Apple data, 45 min"
        onPress={() => longScan('apple')}
      />
      <Button
        testID="long-scan-stop"
        title="Stop the long scan"
        onPress={() => scanRun.current?.abort()}
      />
    </Group>
  );
}
