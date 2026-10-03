import { BleManager, type Peripheral } from 'expo-ble-kit';

import { TestProfile } from './gattNames';

// P2-06 acceptance: a service change on the test peripheral (CONTROL TOGGLE_SECONDARY_SERVICE)
// invalidates the cache and emits servicesChanged; 500 connect/disconnect cycles leave no GATT
// client open (Android `openGattClients`).

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const TOGGLE_SECONDARY = Uint8Array.of(0x03);

export type ServiceChangeReport = {
  /** For each toggle: whether SECONDARY is there afterwards, and how long servicesChanged took. */
  toggles: { present: boolean; ms: number | null }[];
  /** SECONDARY_VALUE could be read while the service was there. */
  readWhilePresent: boolean;
  ok: boolean;
};

/** Waits until the next servicesChanged (null after `timeoutMs`). */
function nextServicesChange(peripheral: Peripheral, timeoutMs: number): Promise<number | null> {
  const started = Date.now();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      listener.remove();
      resolve(null);
    }, timeoutMs);
    const listener = peripheral.addServicesChangedListener(() => {
      clearTimeout(timer);
      listener.remove();
      resolve(Date.now() - started);
    });
  });
}

const hasSecondary = (peripheral: Peripheral) =>
  peripheral.services.some((service) => service.uuid === TestProfile.SECONDARY);

/** Toggles SECONDARY twice (on, then off) on a connected test peripheral. */
export async function runServiceChange(peripheral: Peripheral): Promise<ServiceChangeReport> {
  const toggles: ServiceChangeReport['toggles'] = [];
  let readWhilePresent = false;
  const startedWith = hasSecondary(peripheral);
  for (let n = 0; n < 2; n++) {
    const changed = nextServicesChange(peripheral, 10_000);
    await peripheral.write(TestProfile.TEST, TestProfile.CONTROL, TOGGLE_SECONDARY);
    const ms = await changed;
    toggles.push({ present: hasSecondary(peripheral), ms });
    if (hasSecondary(peripheral)) {
      readWhilePresent = await peripheral
        .read(TestProfile.SECONDARY, TestProfile.SECONDARY_VALUE)
        .then(() => true)
        .catch(() => false);
    }
  }
  const ok =
    toggles.every((toggle) => toggle.ms !== null) &&
    toggles[0].present !== startedWith &&
    toggles[1].present === startedWith &&
    readWhilePresent;
  return { toggles, readWhilePresent, ok };
}

export function describeServiceChange(report: ServiceChangeReport): string {
  const steps = report.toggles
    .map(
      (t) =>
        `${t.present ? 'added' : 'removed'} → ${t.ms === null ? 'no servicesChanged' : `servicesChanged in ${t.ms} ms`}`
    )
    .join('; ');
  return `Service change ${report.ok ? 'OK' : 'FAILED'}: ${steps}${report.readWhilePresent ? '; SECONDARY_VALUE read' : ''}`;
}

export type CyclesReport = {
  cycles: number;
  failures: number;
  /** Android only: GATT clients still open at the end (should be 0). */
  openGattClients: number | null;
  ms: number;
  ok: boolean;
};

/** Connects and disconnects `cycles` times, then reads the open GATT client count. */
export async function runConnectCycles(
  peripheral: Peripheral,
  cycles: number,
  onProgress?: (done: number, failures: number) => void,
  signal?: AbortSignal
): Promise<CyclesReport> {
  const started = Date.now();
  let failures = 0;
  let done = 0;
  for (; done < cycles && !signal?.aborted; done++) {
    try {
      await peripheral.connect({ timeoutMs: 10_000 });
    } catch {
      failures++;
    }
    await peripheral.disconnect().catch(() => {});
    if ((done + 1) % 10 === 0) onProgress?.(done + 1, failures);
  }
  // Closing finishes on the BLE thread right after the disconnect resolves.
  await sleep(500);
  const diagnostics = await BleManager.getDiagnostics();
  const openGattClients = diagnostics.android?.openGattClients ?? null;
  return {
    cycles: done,
    failures,
    openGattClients,
    ms: Date.now() - started,
    ok: done === cycles && failures === 0 && (openGattClients ?? 0) === 0,
  };
}

export function describeCycles(report: CyclesReport): string {
  return (
    `Connect cycles ${report.ok ? 'OK' : 'FAILED'}: ${report.cycles} cycles, ${report.failures} failed, ` +
    `open GATT clients ${report.openGattClients ?? 'n/a'}, ${(report.ms / 1000).toFixed(0)} s`
  );
}
