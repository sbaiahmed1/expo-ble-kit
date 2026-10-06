import { BleError, BleManager, type Peripheral } from 'expo-ble-kit';

import profile from '../../../test-peripherals/profile.json';
import { describeBatchedStream, runBatchedStream } from './batchedStream';
import { TestProfile } from './gattNames';
import { profileValue, type ProfileValue } from './profile';
import { payload, resetCounters, settledCounter } from './sink';

// P4-05: phone A's half of the two-phone suite. Phone B runs the example's Peripheral tab (any test
// peripheral of test-peripherals/profile.json works too). Phone A finds it by the TEST service and
// checks what the peripheral role must do (P4-01 … P4-03): static and long reads, writes and long
// writes, writes without response, the 100 Hz stream without gaps, indications, invalid commands
// and Heart Rate. The same checks as e2e/macos-central, from a phone.

export type SuiteCheck = { name: string; ok: boolean; detail: string };
export type SuiteReport = { peripheral: string | null; checks: SuiteCheck[]; ok: boolean };

const TEST = TestProfile.TEST;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const testCharacteristic = (key: string) =>
  profile.services
    .find((service) => service.key === 'TEST')!
    .characteristics.find((c) => c.key === key) as { value?: ProfileValue } | undefined;
const heartRate = profile.services
  .flatMap((service) => service.characteristics)
  .find((c) => c.key === 'HEART_RATE_MEASUREMENT') as unknown as { minBpm: number; maxBpm: number };
const errors = profile.control.errors;

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);
const describeError = (error: unknown) => {
  const bleError = BleError.fromNative(error);
  return `${bleError.code}: ${bleError.message}`;
};

/** The peripheral's long reads shift the value per handler call: each read must be one shift. */
function snapshotShift(value: Uint8Array, base: Uint8Array): number | null {
  if (value.length !== base.length || value.length === 0) return null;
  const shift = (value[0] - base[0] + 256) % 256;
  return value.every((byte, i) => byte === (base[i] + shift) % 256) ? shift : null;
}

/** The checks, in order. Each resolves with [passed, detail]; a throw fails the check. */
function checks(device: Peripheral, streamSeconds: number): [string, () => Promise<[boolean, string]>][] {
  const write = (key: string, value: Uint8Array, withResponse = true) =>
    device.write(TEST, TestProfile[key], value, { withResponse });
  const read = (key: string) => device.read(TEST, TestProfile[key]);
  /** Reads until the value is `expected`, for up to 1 s: a peripheral may apply a write a moment later. */
  const readBack = async (key: string, expected: Uint8Array) => {
    let value = await read(key);
    for (let waited = 0; !equal(value, expected) && waited < 1000; waited += 100) {
      await sleep(100);
      value = await read(key);
    }
    return value;
  };
  const control = (...bytes: number[]) => write('CONTROL', Uint8Array.from(bytes));
  return [
    [
      'STATIC_READ',
      async () => {
        const value = await read('STATIC_READ');
        return [equal(value, profileValue(testCharacteristic('STATIC_READ')?.value)!), `${value.length} bytes`];
      },
    ],
    [
      'LONG_READ',
      async () => {
        const base = profileValue(testCharacteristic('LONG_READ')?.value)!;
        const shifts = [snapshotShift(await read('LONG_READ'), base), snapshotShift(await read('LONG_READ'), base)];
        return [shifts.every((shift) => shift !== null), `two ${base.length}-byte reads, shifts ${shifts.join(', ')}`];
      },
    ],
    [
      'ECHO',
      async () => {
        await write('ECHO_WRITE', Uint8Array.of(1, 2, 3));
        const short = await readBack('ECHO_READ', Uint8Array.of(1, 2, 3));
        const long = payload(300);
        await write('ECHO_WRITE', long);
        const echoed = await readBack('ECHO_READ', long);
        return [equal(short, Uint8Array.of(1, 2, 3)) && equal(echoed, long), `3 bytes, then ${echoed.length} of 300`];
      },
    ],
    [
      'SINK',
      async () => {
        await resetCounters(device);
        const size = Math.min(100, device.mtu - 3);
        for (let sent = 0; sent < 2000; sent += size) {
          await write('SINK_NO_RSP', payload(Math.min(size, 2000 - sent), sent), false);
        }
        const received = await settledCounter(device, 2000);
        return [received === 2000, `2000 bytes without response in ${size}-byte packets, counter ${received}`];
      },
    ],
    [
      'STREAM',
      async () => {
        const report = await runBatchedStream(device, { seconds: streamSeconds });
        const ok = report.frames > 0 && report.gaps === 0 && report.dropped === 0;
        return [ok, describeBatchedStream(report)];
      },
    ],
    [
      'INDICATE',
      async () => {
        await resetCounters(device);
        const received: number[] = [];
        const subscription = await device.subscribe(
          TEST,
          TestProfile.INDICATE,
          (value) => received.push(new DataView(value.buffer, value.byteOffset, 4).getUint32(0, true)),
          { mode: 'indicate' }
        );
        await control(0x05, 5, 0); // SEND_INDICATIONS(5)
        for (let waited = 0; received.length < 5 && waited < 5000; waited += 100) await sleep(100);
        await subscription.unsubscribe();
        return [received.join() === '0,1,2,3,4', `received ${received.join(', ') || 'nothing'}`];
      },
    ],
    [
      'CONTROL errors',
      async () => {
        // The profile's errors (0x80, 0x81: GATT_ERROR), or the example's (no application errors).
        const refused = async (bytes: number[], codes: string[]) => {
          try {
            await control(...bytes);
            return 'accepted';
          } catch (error) {
            const code = BleError.fromNative(error).code;
            return codes.includes(code) ? null : code;
          }
        };
        const unknown = await refused([0xee], ['NOT_SUPPORTED', 'GATT_ERROR']);
        const invalid = await refused([0x01, 100], ['INVALID_ATTRIBUTE_LENGTH', 'GATT_ERROR']);
        const ok = unknown === null && invalid === null;
        const detail = ok
          ? `unknown opcode and bad parameters refused (profile: 0x${errors.unknownOpcode.attError.toString(16)}, 0x${errors.invalidParameters.attError.toString(16)})`
          : `unknown opcode: ${unknown ?? 'refused'}, bad parameters: ${invalid ?? 'refused'}`;
        return [ok, detail];
      },
    ],
    [
      'Heart Rate',
      async () => {
        const values: number[][] = [];
        const subscription = await device.subscribe(
          TestProfile.HEART_RATE,
          TestProfile.HEART_RATE_MEASUREMENT,
          (value) => values.push([...value])
        );
        for (let waited = 0; values.length < 2 && waited < 5000; waited += 100) await sleep(100);
        await subscription.unsubscribe();
        const ok =
          values.length >= 2 &&
          values.every(([flags, bpm]) => flags === 0 && bpm >= heartRate.minBpm && bpm <= heartRate.maxBpm);
        return [ok, `${values.length} measurements: ${values.map(([, bpm]) => bpm).join(', ')} bpm`];
      },
    ],
  ];
}

/**
 * Finds the peripheral advertising the TEST service, connects, runs the checks and disconnects.
 * `streamSeconds` is how long STREAM runs at 100 Hz (P4-02's acceptance: 600).
 */
export async function runTwoPhoneSuite(
  options: { streamSeconds?: number; onCheck?: (check: SuiteCheck) => void } = {}
): Promise<SuiteReport> {
  const { streamSeconds = 10, onCheck } = options;
  const results: SuiteCheck[] = [];
  const record = (name: string, ok: boolean, detail: string) => {
    const check = { name, ok, detail };
    results.push(check);
    onCheck?.(check);
  };
  const report = (peripheral: string | null): SuiteReport => ({
    peripheral,
    checks: results,
    ok: results.length > 0 && results.every((check) => check.ok),
  });

  const found = await BleManager.scanFor({ services: [TEST], timeoutMs: 15_000 });
  if (!found) {
    record('find', false, 'No device advertises the TEST service within 15 s');
    return report(null);
  }
  record('find', true, `${found.name ?? 'no name'} (${found.id}), ${found.rssi} dBm`);
  const device = BleManager.getPeripheral(found.id);
  try {
    await device.connect({ timeoutMs: 15_000 });
    record('connect', true, `MTU ${device.mtu}`);
    for (const [name, run] of checks(device, streamSeconds)) {
      try {
        const [ok, detail] = await run();
        record(name, ok, detail);
      } catch (error) {
        record(name, false, describeError(error));
        if (device.state !== 'connected') break;
      }
    }
  } catch (error) {
    record('connect', false, describeError(error));
  } finally {
    await device.disconnect().catch(() => {});
  }
  return report(found.id);
}

/** `Two-phone suite OK: 10/10 checks` or `Two-phone suite FAILED: 8/10 checks (STREAM, INDICATE)`. */
export function describeSuite(report: SuiteReport): string {
  const passed = report.checks.filter((check) => check.ok).length;
  const failed = report.checks.filter((check) => !check.ok).map((check) => check.name);
  const counts = `${passed}/${report.checks.length} checks`;
  return report.ok
    ? `Two-phone suite OK: ${counts}`
    : `Two-phone suite FAILED: ${counts} (${failed.join(', ')})`;
}
