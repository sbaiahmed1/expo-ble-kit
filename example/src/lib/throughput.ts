import type { NotificationBatch, Peripheral } from 'expo-ble-kit';

import { TestProfile } from './gattNames';
import { payload, resetCounters, settledCounter } from './sink';

// P2-08: the transfers of docs/benchmarks.md through expo-ble-kit. The native reference apps
// (benchmarks/android-reference, benchmarks/ios-reference) run the same ones with the platform API
// and print results in the same format, so the two can be compared line by line.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const setStream = (rateHz: number, frameSize: number) =>
  Uint8Array.of(0x01, rateHz & 0xff, rateHz >> 8, frameSize & 0xff, frameSize >> 8);

export type TransferName =
  'writeWithoutResponse' | 'writeWithResponse' | 'notifications' | 'notificationsUnbatched';

export type TransferResult = { name: TransferName; bytes: number; ms: number; note: string };

export function kilobytesPerSecond(result: TransferResult): number {
  return result.bytes / 1024 / (result.ms / 1000);
}

/** `writeWithoutResponse: 1048576 B in 9.12 s = 112.3 KB/s (244-byte packets, …)`, as the reference apps print. */
export function describeTransfer(result: TransferResult): string {
  return (
    `${result.name}: ${result.bytes} B in ${(result.ms / 1000).toFixed(2)} s = ` +
    `${kilobytesPerSecond(result).toFixed(1)} KB/s (${result.note})`
  );
}

/** 1 MiB to SINK_NO_RSP in one writeStream (packets of MTU − 3, without response). */
export async function writeWithoutResponse(
  peripheral: Peripheral,
  total = 1 << 20
): Promise<TransferResult> {
  await resetCounters(peripheral);
  const started = Date.now();
  await peripheral.writeStream(TestProfile.TEST, TestProfile.SINK_NO_RSP, payload(total));
  const ms = Date.now() - started;
  const counted = await settledCounter(peripheral, total);
  const note = `${peripheral.mtu - 3}-byte packets, peripheral counted ${counted}`;
  return { name: 'writeWithoutResponse', bytes: total, ms, note };
}

/** 256 KiB to ECHO_WRITE in one writeStream with response (one packet per write). */
export async function writeWithResponse(
  peripheral: Peripheral,
  total = 256 << 10
): Promise<TransferResult> {
  const started = Date.now();
  await peripheral.writeStream(TestProfile.TEST, TestProfile.ECHO_WRITE, payload(total), {
    withResponse: true,
  });
  const ms = Date.now() - started;
  return {
    name: 'writeWithResponse',
    bytes: total,
    ms,
    note: `${peripheral.mtu - 3}-byte packets`,
  };
}

/**
 * STREAM at 1000 Hz with frames of MTU − 3 bytes (512 at most) for `seconds`, received through a
 * batched subscription (16 ms), or one event per value with `batched: false`.
 */
export async function notifications(
  peripheral: Peripheral,
  { seconds = 10, batched = true }: { seconds?: number; batched?: boolean } = {}
): Promise<TransferResult> {
  let bytes = 0;
  let frames = 0;
  let gaps = 0;
  let expected = 0;
  const count = (value: Uint8Array) => {
    if (value.length < 4) return;
    const sequence = new DataView(value.buffer, value.byteOffset, 4).getUint32(0, true);
    if (sequence > expected) gaps += sequence - expected;
    expected = sequence + 1;
    frames++;
    bytes += value.length;
  };
  const subscription = batched
    ? await peripheral.subscribeBatched(
        TestProfile.TEST,
        TestProfile.STREAM,
        (batch: NotificationBatch) => batch.values.forEach(count),
        { intervalMs: 16 }
      )
    : await peripheral.subscribe(TestProfile.TEST, TestProfile.STREAM, count);
  const frameSize = Math.min(peripheral.mtu - 3, 512);
  try {
    await resetCounters(peripheral);
    [bytes, frames, gaps, expected] = [0, 0, 0, 0];
    const started = Date.now();
    await peripheral.write(TestProfile.TEST, TestProfile.CONTROL, setStream(1000, frameSize));
    await sleep(seconds * 1000);
    const received = bytes;
    const ms = Date.now() - started;
    await peripheral.write(TestProfile.TEST, TestProfile.CONTROL, setStream(0, frameSize));
    // Frames already on their way arrive before the next run starts counting.
    await sleep(300);
    const note = `${frames} frames of ${frameSize} B, ${gaps} gaps${batched ? '' : ', unbatched'}`;
    return {
      name: batched ? 'notifications' : 'notificationsUnbatched',
      bytes: received,
      ms,
      note,
    };
  } finally {
    await subscription.unsubscribe().catch(() => {});
  }
}

/** The reference apps' three transfers, then the unbatched notifications for comparison. */
export async function runAll(
  peripheral: Peripheral,
  onResult: (result: TransferResult) => void,
  seconds = 10
): Promise<TransferResult[]> {
  const results: TransferResult[] = [];
  for (const run of [
    () => writeWithoutResponse(peripheral),
    () => writeWithResponse(peripheral),
    () => notifications(peripheral, { seconds }),
    () => notifications(peripheral, { seconds, batched: false }),
  ]) {
    const result = await run();
    results.push(result);
    onResult(result);
  }
  return results;
}
