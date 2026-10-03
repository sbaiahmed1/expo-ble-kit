import type { BleBackgroundEvent } from 'expo-ble-kit';
import * as TaskManager from 'expo-task-manager';

// P3-04: the task of the background scan, defined at module scope (index.ts imports it first) so it
// exists when Android starts the app headless for a scan result. It logs each delivery (Logcat tag
// ReactNativeJS) and keeps the latest ones for the developer checks while the app is open.

export const BACKGROUND_SCAN_TASK = 'blekit-background-scan';

export type Delivery = { at: number; count: number; ids: string[] };

let deliveries: Delivery[] = [];
const listeners = new Set<(deliveries: Delivery[]) => void>();

TaskManager.defineTask<BleBackgroundEvent>(BACKGROUND_SCAN_TASK, async ({ data, error }) => {
  if (error) {
    console.warn(`BleKit background task error: ${error.message}`);
    return;
  }
  if (data?.type !== 'scanResults') return;
  const ids = data.results.map((result) => result.id);
  // The bytes arrive as Uint8Array, like in the foreground.
  const bytes = data.results.flatMap((result) => Object.values(result.manufacturerData))[0];
  console.log(
    `BleKit background task: ${ids.length} results (${ids.join(', ')}); ` +
      `manufacturer data ${bytes ? `${bytes.constructor.name}(${bytes.length})` : 'none'}`
  );
  deliveries = [{ at: Date.now(), count: ids.length, ids }, ...deliveries].slice(0, 20);
  listeners.forEach((listener) => listener(deliveries));
});

/** The deliveries so far in this process, newest first; `listener` hears every new one. */
export function watchDeliveries(listener: (deliveries: Delivery[]) => void): () => void {
  listeners.add(listener);
  listener(deliveries);
  return () => listeners.delete(listener);
}
