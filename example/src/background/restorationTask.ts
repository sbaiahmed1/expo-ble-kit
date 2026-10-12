import type { BleBackgroundEvent } from 'expo-ble-kit';
import * as TaskManager from 'expo-task-manager';

// P3-02: the task of iOS's restoration events (S-B2), defined at module scope (index.ts imports
// it) so TaskManager finds it when JS starts. A background relaunch runs no JS: TaskManager keeps
// the events until the app opens, then delivers them here in order.

export const RESTORATION_TASK = 'blekit-restoration';

export type RestorationDelivery = { at: number; summary: string };

let deliveries: RestorationDelivery[] = [];
const listeners = new Set<(deliveries: RestorationDelivery[]) => void>();

function summarize(event: BleBackgroundEvent): string {
  switch (event.type) {
    case 'restored':
      return `restored ${event.peripheralIds.join(', ')}`;
    case 'connectionStateChange':
      return `${event.peripheralId} ${event.state}`;
    case 'notification':
      return `notification ${event.characteristic.slice(4, 8)}: ${[...event.value].join(' ')} (${event.value.constructor.name})`;
    default:
      return event.type;
  }
}

TaskManager.defineTask<BleBackgroundEvent>(RESTORATION_TASK, async ({ data, error }) => {
  if (error) {
    console.warn(`BleKit restoration task error: ${error.message}`);
    return;
  }
  if (!data) return;
  const summary = summarize(data);
  console.log(`BleKit restoration task: ${summary}`);
  deliveries = [{ at: Date.now(), summary }, ...deliveries].slice(0, 50);
  listeners.forEach((listener) => listener(deliveries));
});

/** The deliveries so far in this process, newest first; `listener` hears every new one. */
export function watchRestorationDeliveries(
  listener: (deliveries: RestorationDelivery[]) => void
): () => void {
  listeners.add(listener);
  listener(deliveries);
  return () => listeners.delete(listener);
}
