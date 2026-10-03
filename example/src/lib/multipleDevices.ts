import { BleManager, type Peripheral } from 'expo-ble-kit';

import { TestProfile } from './gattNames';

// P2-05 acceptance: several test peripherals connected at once, each streaming; one drops itself
// (CONTROL DISCONNECT_AFTER), and the others keep streaming and answering reads.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const setStream = (rateHz: number) => Uint8Array.of(0x01, rateHz, 0, 20, 0);
const DISCONNECT_NOW = Uint8Array.of(0x02, 0, 0, 0, 0);

export type DeviceReport = {
  name: string;
  /** Frames received before and after the drop. */
  before: number;
  after: number;
  state: string;
  readOk: boolean;
};

export type MultipleDevicesReport = {
  found: number;
  connected: number;
  dropped: string | null;
  others: DeviceReport[];
  ok: boolean;
};

/** Every test peripheral advertising its service within `scanMs`, by id. */
async function findTestPeripherals(scanMs: number): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const session = BleManager.startScan({ services: [TestProfile.TEST] }, (results) =>
    results.forEach((result) => found.set(result.id, result.name ?? result.id))
  );
  await sleep(scanMs);
  session.stop();
  return found;
}

/**
 * Connects every test peripheral found (at least `minDevices` for an OK), streams 20 Hz from each,
 * makes the first one drop, and checks the others kept streaming and answer reads.
 */
export async function runMultipleDevices(options: {
  minDevices?: number;
  scanMs?: number;
  phaseMs?: number;
  onStatus?: (status: string) => void;
}): Promise<MultipleDevicesReport> {
  const { minDevices = 5, scanMs = 5000, phaseMs = 3000, onStatus } = options;
  onStatus?.('Scanning for test peripherals…');
  const found = await findTestPeripherals(scanMs);
  const names = new Map<Peripheral, string>();
  found.forEach((name, id) => names.set(BleManager.getPeripheral(id), name));
  const all = [...names.keys()];
  onStatus?.(`Connecting ${all.length} test peripherals at once…`);
  const results = await Promise.allSettled(all.map((p) => p.connect({ timeoutMs: 15_000 })));
  const connected = all.filter((_, n) => results[n].status === 'fulfilled');
  const frames = new Map<Peripheral, number>();
  try {
    await Promise.all(
      connected.map(async (peripheral) => {
        frames.set(peripheral, 0);
        await peripheral.subscribe(TestProfile.TEST, TestProfile.STREAM, () =>
          frames.set(peripheral, (frames.get(peripheral) ?? 0) + 1)
        );
        await peripheral.write(TestProfile.TEST, TestProfile.CONTROL, setStream(20));
      })
    );
    onStatus?.(`${connected.length} connected and streaming…`);
    await sleep(phaseMs);
    const [victim, ...others] = connected;
    const before = new Map(others.map((p) => [p, frames.get(p) ?? 0]));
    if (victim) {
      await victim.write(TestProfile.TEST, TestProfile.CONTROL, DISCONNECT_NOW).catch(() => {});
      for (let waited = 0; victim.state !== 'disconnected' && waited < 5000; waited += 100) {
        await sleep(100);
      }
      onStatus?.(`${names.get(victim)} dropped; watching the others…`);
    }
    await sleep(phaseMs);
    const reports = await Promise.all(
      others.map(async (p) => {
        const readOk = await p.read(TestProfile.TEST, TestProfile.STATIC_READ).then(
          () => true,
          () => false
        );
        return {
          name: names.get(p)!,
          before: before.get(p) ?? 0,
          after: frames.get(p) ?? 0,
          state: p.state,
          readOk,
        };
      })
    );
    const ok =
      connected.length >= minDevices &&
      victim?.state === 'disconnected' &&
      reports.every((r) => r.after > r.before && r.state === 'connected' && r.readOk);
    return {
      found: all.length,
      connected: connected.length,
      dropped: victim ? names.get(victim)! : null,
      others: reports,
      ok,
    };
  } finally {
    await Promise.all(
      connected.map(async (p) => {
        await p.write(TestProfile.TEST, TestProfile.CONTROL, setStream(0)).catch(() => {});
        await p.disconnect().catch(() => {});
      })
    );
  }
}

/** `Multiple devices OK: 5 of 5 connected; after BleKit-Test dropped, 4 others kept streaming…` */
export function describeMultipleDevices(report: MultipleDevicesReport): string {
  const others = report.others
    .map((r) => `${r.name} +${r.after - r.before}${r.readOk ? '' : ' (read failed)'}`)
    .join(', ');
  return (
    `Multiple devices ${report.ok ? 'OK' : 'FAILED'}: ${report.connected} of ${report.found} ` +
    `connected; after ${report.dropped ?? 'none'} dropped, ${report.others.length} others kept ` +
    `streaming (${others})`
  );
}
