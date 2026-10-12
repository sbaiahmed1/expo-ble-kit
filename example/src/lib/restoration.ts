import {
  BleError,
  BleManager,
  GattCharacteristics,
  GattServices,
  type Subscription,
} from 'expo-ble-kit';
import { useEffect } from 'react';
import { Linking } from 'react-native';


import { TestProfile } from './gattNames';
import { RESTORATION_TASK } from '../background/restorationTask';

// P3-01/P3-02 (S-B2): what the restoration check arms. e2e/ios-restoration/run.sh opens
// `expo.modules.blekit.example://restoration/arm` to arm it without touching the screen.

let subscription: Subscription | null = null;

/**
 * Registers the restoration task, connects to the test peripheral and keeps its 1 Hz heart rate
 * notifications on, reporting progress to `onStatus`.
 */
export async function armRestoration(onStatus: (status: string) => void): Promise<void> {
  await BleManager.registerBackgroundTask(RESTORATION_TASK, {
    events: ['restored', 'connectionStateChange', 'notification'],
  });
  onStatus('Looking for the test peripheral…');
  const found = await BleManager.scanFor({ services: [TestProfile.TEST], timeoutMs: 10_000 });
  if (!found) return onStatus('No test peripheral found');
  const device = BleManager.getPeripheral(found.id);
  await device.connect();
  subscription?.remove();
  let count = 0;
  let gaps = 0;
  let last: number | null = null;
  subscription = await device.subscribe(
    GattServices.HeartRate,
    GattCharacteristics.HeartRateMeasurement,
    (value) => {
      const bpm = value[1];
      // The test peripheral counts 60 to 100 and wraps (test-peripherals/profile.json).
      if (last !== null && bpm !== (last >= 100 ? 60 : last + 1)) gaps += 1;
      last = bpm;
      count += 1;
      onStatus(`Connected to ${device.id}: ${count} heart rate values, ${gaps} gaps, the last ${bpm} bpm`);
    }
  );
  onStatus(`Connected to ${device.id}, waiting for heart rate values`);
}

/** Arms the check when the app opens `…://restoration/arm`; progress goes to the console. */
export function useRestorationLink(): void {
  useEffect(() => {
    let lastKind = '';
    let lines = 0;
    const log = (status: string) => {
      // One line per state, then one per 30 heart rate values.
      const kind = status.replace(/\d+/g, '#');
      if (kind !== lastKind || ++lines % 30 === 0) console.log(`BleKit restoration: ${status}`);
      lastKind = kind;
    };
    const handle = (url: string | null) => {
      if (!url?.includes('restoration/arm')) return;
      if (url.includes('debug')) {
        // e2e/ios-restoration/run.sh --debug: the library's log in Metro's output.
        BleManager.setLogLevel('debug');
        BleManager.setLogHandler((entry) =>
          console.log(`BleKit log: ${entry.level} ${entry.peripheralId ?? ''} ${entry.message}`)
        );
      }
      armRestoration(log).catch((error) => {
        const bleError = BleError.fromNative(error);
        console.warn(`BleKit restoration: ${bleError.code}: ${bleError.message}`);
      });
    };
    Linking.getInitialURL().then(handle, () => {});
    const listener = Linking.addEventListener('url', ({ url }) => handle(url));
    return () => listener.remove();
  }, []);
}
