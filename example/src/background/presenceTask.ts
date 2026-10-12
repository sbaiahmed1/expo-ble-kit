import type { BleBackgroundEvent } from 'expo-ble-kit';
import * as TaskManager from 'expo-task-manager';

// P5-05: the task of companion device presence (S-B5), defined at module scope (index.ts imports
// it) so it exists when Android binds the presence service and TaskManager starts the app headless.
// It logs each change (Logcat tag ReactNativeJS) and keeps the latest ones for the checks.

export const PRESENCE_TASK = 'blekit-presence';

export type PresenceChange = { at: number; id: string; present: boolean };

let changes: PresenceChange[] = [];
const listeners = new Set<(changes: PresenceChange[]) => void>();

TaskManager.defineTask<BleBackgroundEvent>(PRESENCE_TASK, async ({ data, error }) => {
  if (error) {
    console.warn(`BleKit presence task error: ${error.message}`);
    return;
  }
  if (data?.type !== 'devicePresence') return;
  console.log(`BleKit presence task: ${data.peripheralId} ${data.present ? 'in range' : 'gone'}`);
  changes = [{ at: Date.now(), id: data.peripheralId, present: data.present }, ...changes].slice(
    0,
    20
  );
  listeners.forEach((listener) => listener(changes));
});

/** The changes so far in this process, newest first; `listener` hears every new one. */
export function watchPresence(listener: (changes: PresenceChange[]) => void): () => void {
  listeners.add(listener);
  listener(changes);
  return () => listeners.delete(listener);
}
