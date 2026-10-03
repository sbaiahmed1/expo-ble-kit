import {
  BleError,
  BleErrorCode,
  BleManager,
  type BleState,
  type Peripheral,
  type ScanOptions,
  type ScanSession,
} from 'expo-ble-kit';

import { TestProfile } from './gattNames';

// P2-09 soak suite (plan §8.5), the in-app halves: Bluetooth turned off and on during active
// operations, and a long filtered scan. The host halves (adb toggles, memory samples, the crash
// check) are in e2e/soak/; docs/soak.md has the method and the results.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const CODES = new Set<string>(Object.values(BleErrorCode));
/** An operation pending when Bluetooth goes off must settle within this. */
const SETTLE_AFTER_OFF_MS = 5_000;

export type ToggleSoakReport = {
  /** Times the adapter went off during the run. */
  offs: number;
  /** Operations started (connects, discovery, reads, writes, streams, disconnects). */
  started: number;
  succeeded: number;
  /** Rejections by error code. */
  codes: Record<string, number>;
  /** Rejections without a known error code (should be none). */
  uncoded: string[];
  /** Scan sessions the adapter ended, by error code. */
  scanEnds: Record<string, number>;
  /** Operations pending when Bluetooth went off that took longer than 5 s to settle. */
  late: string[];
  /** Operations still pending at the end, after the grace period (should be none). */
  unsettled: string[];
  /** Whether the test peripheral took part (otherwise: the scan and the absent device only). */
  withPeripheral: boolean;
  ms: number;
  ok: boolean;
};

export type ToggleSoakOptions = {
  /** A device that isn't there: its connects stay pending until Bluetooth goes off. */
  absent: Peripheral;
  /** The test peripheral, when there is one: connect, subscribe, then reads, writes and streams. */
  peripheral?: Peripheral | null;
  /** Ends the run. Ops in flight are not cancelled: they have `graceMs` to settle on their own. */
  signal: AbortSignal;
  /**
   * Demo mode: the check turns the adapter off and on itself, `toggles` times, then ends. On a
   * phone, e2e/soak/bluetooth-toggle.sh does the toggling.
   */
  toggle?: (on: boolean) => void;
  toggles?: number;
  /** Offs needed for OK. Defaults to `toggles` (50). */
  minOffs?: number;
  /** Longer than the longest operation timeout below (20 s). */
  graceMs?: number;
  onUpdate?: (sofar: ToggleSoakReport) => void;
};

/**
 * Keeps operations running while Bluetooth goes off and on: a filtered scan (restarted each time
 * the adapter is back), connects to a device that isn't there, and, with a test peripheral,
 * connect → subscribe → reads, writes and short streams until each drop. Every operation must
 * settle with a coded error or a value, and those pending at an off must settle right away.
 */
export async function runToggleSoak(options: ToggleSoakOptions): Promise<ToggleSoakReport> {
  const { absent, peripheral, signal, toggle, toggles = 50, graceMs = 25_000 } = options;
  const minOffs = options.minOffs ?? toggles;
  const startedAt = Date.now();
  const report: ToggleSoakReport = {
    offs: 0,
    started: 0,
    succeeded: 0,
    codes: {},
    uncoded: [],
    scanEnds: {},
    late: [],
    unsettled: [],
    withPeripheral: !!peripheral,
    ms: 0,
    ok: false,
  };
  const pending = new Map<number, { kind: string; at: number; offAt?: number }>();
  let nextOp = 0;
  let running = true;
  let state: BleState = BleManager.state;
  let waiters: (() => void)[] = [];
  let scan: ScanSession | null = null;
  const update = () => options.onUpdate?.({ ...report, ms: Date.now() - startedAt });

  const settled = (id: number) => {
    const op = pending.get(id)!;
    pending.delete(id);
    if (op.offAt !== undefined && Date.now() - op.offAt > SETTLE_AFTER_OFF_MS) {
      report.late.push(`${op.kind} settled ${Date.now() - op.offAt} ms after Bluetooth went off`);
    }
  };
  /** Runs `op`, counting how it settles. */
  function track<T>(kind: string, op: () => Promise<T>): Promise<T> {
    const id = nextOp++;
    report.started++;
    pending.set(id, { kind, at: Date.now() });
    let promise: Promise<T>;
    try {
      promise = op();
    } catch (error) {
      promise = Promise.reject(error);
    }
    return promise.then(
      (value) => {
        settled(id);
        report.succeeded++;
        return value;
      },
      (error: unknown) => {
        settled(id);
        const code = error instanceof BleError ? error.code : null;
        if (code && CODES.has(code)) report.codes[code] = (report.codes[code] ?? 0) + 1;
        else report.uncoded.push(`${kind}: ${String(error)}`);
        throw error;
      }
    );
  }

  const whenOn = () =>
    new Promise<void>((resolve) => {
      if (!running || state === 'poweredOn') resolve();
      else waiters.push(resolve);
    });
  const wakeAll = () => {
    waiters.forEach((resolve) => resolve());
    waiters = [];
  };

  function startScan() {
    if (!running || scan || state !== 'poweredOn') return;
    try {
      scan = BleManager.startScan(
        { services: [TestProfile.TEST] },
        () => {},
        (error) => {
          report.scanEnds[error.code] = (report.scanEnds[error.code] ?? 0) + 1;
          scan = null;
        }
      );
    } catch (error) {
      const code = error instanceof BleError ? error.code : 'uncoded';
      report.scanEnds[code] = (report.scanEnds[code] ?? 0) + 1;
    }
  }

  function stopScan() {
    scan?.stop();
    scan = null;
  }

  const stateListener = BleManager.addStateListener((next) => {
    if (state === 'poweredOn' && next !== 'poweredOn') {
      const now = Date.now();
      pending.forEach((op) => (op.offAt ??= now));
    }
    if (next === 'poweredOff' && state !== 'poweredOff') report.offs++;
    state = next;
    if (next === 'poweredOn') {
      wakeAll();
      // The adapter needs a moment after STATE_ON before a scan starts reliably.
      setTimeout(startScan, 500);
    }
    update();
  });

  async function absentWorker() {
    while (running) {
      await whenOn();
      if (!running) break;
      await track('connect (absent)', () => absent.connect({ timeoutMs: 20_000 })).catch(() => {});
      await track('disconnect (absent)', () => absent.disconnect()).catch(() => {});
      await sleep(200);
    }
  }

  async function peripheralWorker(device: Peripheral) {
    const { TEST, STATIC_READ, ECHO_WRITE, SINK_NO_RSP, STREAM } = TestProfile;
    while (running) {
      await whenOn();
      if (!running) break;
      try {
        await track('connect', () => device.connect({ timeoutMs: 15_000 }));
        await track('subscribe', () => device.subscribe(TEST, STREAM, () => {}));
        for (let n = 0; running; n++) {
          await track('read', () => device.read(TEST, STATIC_READ));
          await track('write', () => device.write(TEST, ECHO_WRITE, Uint8Array.of(n & 0xff)));
          if (n % 10 === 9) {
            const data = new Uint8Array(8 * 1024);
            await track('writeStream', () =>
              device.writeStream(TEST, SINK_NO_RSP, data, { withResponse: false })
            );
          }
          await sleep(50);
        }
      } catch {
        // Counted by track(); try again once the adapter is back.
      }
      await track('disconnect', () => device.disconnect()).catch(() => {});
      await sleep(500);
    }
  }

  const ended = new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    signal.addEventListener('abort', () => resolve());
  });
  async function toggler(set: (on: boolean) => void) {
    for (let n = 0; n < toggles && !signal.aborted; n++) {
      await sleep(1_500);
      set(false);
      await sleep(500);
      set(true);
    }
    await sleep(1_000);
  }

  startScan();
  // Not awaited: an operation that never settles would block its worker forever.
  void absentWorker();
  if (peripheral) void peripheralWorker(peripheral);
  const progress = setInterval(update, 1_000);
  await (toggle ? Promise.race([toggler(toggle), ended]) : ended);

  running = false;
  wakeAll();
  stopScan();
  for (const deadline = Date.now() + graceMs; pending.size > 0 && Date.now() < deadline; ) {
    await sleep(250);
  }
  clearInterval(progress);
  stateListener.remove();
  const now = Date.now();
  report.unsettled = [...pending.values()].map(
    (op) => `${op.kind}, pending for ${Math.round((now - op.at) / 1000)} s`
  );
  report.ms = now - startedAt;
  report.ok =
    report.offs >= minOffs &&
    report.started > 0 &&
    report.uncoded.length === 0 &&
    report.late.length === 0 &&
    report.unsettled.length === 0;
  return report;
}

const counts = (codes: Record<string, number>) =>
  Object.entries(codes)
    .sort(([, a], [, b]) => b - a)
    .map(([code, n]) => `${code} ${n}`)
    .join(', ') || 'none';

/** `Toggle soak OK: 50 offs, 1834 ops (1702 ok); errors BLUETOOTH_POWERED_OFF 98, …`. */
export function describeToggleSoak(report: ToggleSoakReport, done = true): string {
  const scanEnds = Object.values(report.scanEnds).reduce((sum, n) => sum + n, 0);
  const problems = [
    ...report.uncoded.slice(0, 3).map((line) => `uncoded ${line}`),
    ...report.late.slice(0, 3),
    ...report.unsettled.slice(0, 3).map((line) => `never settled: ${line}`),
  ];
  return (
    `Toggle soak ${done ? (report.ok ? 'OK' : 'FAILED') : 'running…'}: ${report.offs} offs, ` +
    `${report.started} ops (${report.succeeded} ok); errors ${counts(report.codes)}; ` +
    `scans ended ${scanEnds} (${counts(report.scanEnds)}); ${report.uncoded.length} uncoded, ` +
    `${report.late.length} late, ${report.unsettled.length} unsettled; ` +
    `${report.withPeripheral ? 'with the test peripheral' : 'no test peripheral'}, ` +
    `${(report.ms / 1000).toFixed(0)} s` +
    (problems.length ? `\n${problems.join('\n')}` : '')
  );
}

export type LongScanReport = {
  /** What the scan filtered on. */
  filter: string;
  /** Results in each minute so far. */
  perMinute: number[];
  /** The minutes (1-based) without a single result. */
  emptyMinutes: number[];
  /** Why the scan ended early, when the adapter or the platform ended it. */
  error: string | null;
  /** The planned length. */
  minutes: number;
  ok: boolean;
};

export type LongScanOptions = {
  /** A label for `filter` in the report, and the scan options (a filter is required). */
  filter: { label: string; options: ScanOptions };
  minutes?: number;
  signal?: AbortSignal;
  onUpdate?: (sofar: LongScanReport) => void;
};

/**
 * A filtered scan left running for `minutes` (default 45): it must deliver results every minute.
 * Android downgrades scans older than about 30 minutes, which the core avoids by restarting them
 * (plan §4.4); this is the check that it works.
 */
export async function runLongScan(options: LongScanOptions): Promise<LongScanReport> {
  const { filter, minutes = 45, signal } = options;
  const report: LongScanReport = {
    filter: filter.label,
    perMinute: [],
    emptyMinutes: [],
    error: null,
    minutes,
    ok: false,
  };
  let current = 0;
  let finish = () => {};
  const finished = new Promise<void>((resolve) => (finish = resolve));
  const session = BleManager.startScan(
    { ...filter.options, allowDuplicates: true, reportIntervalMs: 1_000 },
    (results) => (current += results.length),
    (error) => {
      report.error = `${error.code}: ${error.message}`;
      finish();
    }
  );
  const minuteTimer = setInterval(() => {
    report.perMinute.push(current);
    if (current === 0) report.emptyMinutes.push(report.perMinute.length);
    current = 0;
    options.onUpdate?.({ ...report });
    if (report.perMinute.length >= minutes) finish();
  }, 60_000);
  signal?.addEventListener('abort', finish);
  await finished;
  clearInterval(minuteTimer);
  session.stop();
  report.ok =
    report.error === null &&
    report.perMinute.length >= minutes &&
    report.emptyMinutes.length === 0;
  return report;
}

/** `Long scan OK: Apple data, 45 / 45 min, results per minute 212–388, no empty minute`. */
export function describeLongScan(report: LongScanReport, done = true): string {
  const counted = report.perMinute.length;
  const range = counted
    ? `results per minute ${Math.min(...report.perMinute)}–${Math.max(...report.perMinute)}`
    : 'no full minute yet';
  const empty = report.emptyMinutes.length
    ? `empty minutes ${report.emptyMinutes.join(', ')}`
    : 'no empty minute';
  return (
    `Long scan ${done ? (report.ok ? 'OK' : 'FAILED') : 'running…'}: ${report.filter}, ` +
    `${counted} / ${report.minutes} min, ${range}, ${empty}` +
    (report.error ? `; ended by ${report.error}` : '')
  );
}
