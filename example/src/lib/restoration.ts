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
import { serverAdvertisement, serverServices, serveTestProfile } from './serverProfile';
import { RESTORATION_TASK } from '../background/restorationTask';

// P3-01/P3-02 (S-B2): what the restoration check arms. e2e/ios-restoration/run.sh opens
// `expo.modules.blekit.example://restoration/arm` to arm it without touching the screen, and
// `…://server/serve` for the peripheral role (P4-04): the test GATT server, advertised.

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

let serving = false;

/**
 * Opens the test GATT server and advertises it, for P4-04: after iOS stops the app, the services
 * and the advertisement live on, and the server JS opens again with the same services adopts them.
 * Requests go to the console.
 */
export async function serveForRestoration(): Promise<void> {
  if (serving) return;
  serving = true;
  const server = await BleManager.openGattServer(serverServices);
  serveTestProfile(server, (line) => console.log(`BleKit server: ${line}`));
  await BleManager.startAdvertising(serverAdvertisement);
  console.log('BleKit server: open and advertising');
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
      if (url?.includes('server/serve')) {
        serveForRestoration().catch((error) => {
          serving = false;
          const bleError = BleError.fromNative(error);
          console.warn(`BleKit server: ${bleError.code}: ${bleError.message}`);
        });
        return;
      }
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
    // P4-04: a GATT server iOS restored at this launch is served again, as an app would on start.
    BleManager.getDiagnostics()
      .then(({ ios }) => {
        const events = (ios?.restoration.journal ?? []).map((entry) => entry.event);
        const launched = events.findLastIndex((event) => event.startsWith('launched'));
        const restored = events.slice(Math.max(0, launched));
        if (restored.some((event) => event.startsWith('restored the GATT server'))) {
          console.log('BleKit server: iOS restored it, serving again');
          return serveForRestoration();
        }
      })
      .catch((error) => {
        serving = false;
        const bleError = BleError.fromNative(error);
        console.warn(`BleKit server: ${bleError.code}: ${bleError.message}`);
      });
    const listener = Linking.addEventListener('url', ({ url }) => handle(url));
    return () => listener.remove();
  }, []);
}
