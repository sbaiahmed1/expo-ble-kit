import type { Peripheral } from 'expo-ble-kit';

import { TestProfile } from './gattNames';

// P2-02 and P2-03 acceptance: bytes sent to the test peripheral through repeated writes without
// response, or one writeStream, arrive complete; an aborted stream stops. SINK_NO_RSP discards what
// it receives and counts it in SINK_COUNTER.

const RESET_COUNTERS = Uint8Array.of(0x04);
/** Writes issued before waiting for the oldest: keeps the native queue busy between JS turns. */
const WINDOW = 8;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type SinkReport = {
  /** Bytes the phone's stack took. */
  sent: number;
  /** Bytes the peripheral counted. */
  received: number;
  /** Bytes per write (MTU − 3). */
  packetSize: number;
  /** From the first write until the last one resolved. */
  ms: number;
};

/** SINK_COUNTER: bytes received since the last RESET_COUNTERS. */
export async function readSinkCounter(peripheral: Peripheral): Promise<number> {
  const value = await peripheral.read(TestProfile.TEST, TestProfile.SINK_COUNTER);
  return new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(0, true);
}

/** CONTROL RESET_COUNTERS (SINK_COUNTER, the STREAM and INDICATE sequences); checks SINK_COUNTER. */
export async function resetCounters(peripheral: Peripheral): Promise<void> {
  await peripheral.write(TestProfile.TEST, TestProfile.CONTROL, RESET_COUNTERS);
  for (let polls = 0; (await readSinkCounter(peripheral)) !== 0; polls++) {
    if (polls === 10) throw new Error('SINK_COUNTER did not reset');
    await sleep(100);
  }
}

/**
 * Reads SINK_COUNTER until it reaches `sent` or stops growing: packets the phone's stack took may
 * still be on their way.
 */
async function settledCounter(peripheral: Peripheral, sent: number): Promise<number> {
  let received = await readSinkCounter(peripheral);
  for (let still = 0; received < sent && still < 5;) {
    await sleep(200);
    const next = await readSinkCounter(peripheral);
    still = next === received ? still + 1 : 0;
    received = next;
  }
  return received;
}

/** The bytes 0, 1, 2… 255, 0… of the test payloads, starting at byte `from`. */
function payload(length: number, from = 0): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (from + i) % 256);
}

/**
 * P2-02: resets the counters, sends `totalBytes` to SINK_NO_RSP in packets of MTU − 3 bytes
 * without response, then reads SINK_COUNTER until it reaches the total or stops growing. Rejects
 * with the first failed write.
 */
export async function sendToSink(
  peripheral: Peripheral,
  totalBytes: number,
  onProgress?: (sent: number) => void
): Promise<SinkReport> {
  await resetCounters(peripheral);
  const packetSize = peripheral.mtu - 3;
  const inFlight = new Set<Promise<void>>();
  let failure: unknown = null;
  let sent = 0;
  const started = Date.now();
  while (sent < totalBytes && failure === null) {
    const packet = payload(Math.min(packetSize, totalBytes - sent), sent);
    const write: Promise<void> = peripheral
      .write(TestProfile.TEST, TestProfile.SINK_NO_RSP, packet, { withResponse: false })
      .catch((error: unknown) => {
        failure ??= error;
      })
      .then(() => {
        inFlight.delete(write);
      });
    inFlight.add(write);
    sent += packet.length;
    if (inFlight.size >= WINDOW) await Promise.race(inFlight);
    onProgress?.(sent);
  }
  await Promise.all(inFlight);
  if (failure !== null) throw failure;
  const ms = Date.now() - started;
  return { sent, received: await settledCounter(peripheral, sent), packetSize, ms };
}

/** P2-03: like `sendToSink`, with one `writeStream`: chunking and flow control are native. */
export async function streamToSink(
  peripheral: Peripheral,
  totalBytes: number,
  onProgress?: (sent: number) => void
): Promise<SinkReport> {
  await resetCounters(peripheral);
  const started = Date.now();
  await peripheral.writeStream(TestProfile.TEST, TestProfile.SINK_NO_RSP, payload(totalBytes), {
    onProgress: (sent) => onProgress?.(sent),
  });
  const ms = Date.now() - started;
  const received = await settledCounter(peripheral, totalBytes);
  return { sent: totalBytes, received, packetSize: peripheral.mtu - 3, ms };
}

export type AbortReport = {
  /** What the stream settled with: a BleErrorCode, or 'resolved'. */
  code: string;
  /** From `abort()` to the rejection. */
  rejectedAfterMs: number;
  /** Bytes the last progress report counted when the abort happened. */
  reportedAtAbort: number;
  /** Bytes the peripheral counted once the counter stopped growing. */
  received: number;
  total: number;
};

/**
 * P2-03: aborts a `totalBytes` stream once it reported `abortAt` bytes, then measures how fast it
 * rejected and where the peripheral's counter stopped.
 */
export async function abortStreamToSink(
  peripheral: Peripheral,
  totalBytes: number,
  abortAt: number
): Promise<AbortReport> {
  await resetCounters(peripheral);
  const controller = new AbortController();
  let reportedAtAbort = 0;
  let abortedAt = 0;
  const code = await peripheral
    .writeStream(TestProfile.TEST, TestProfile.SINK_NO_RSP, payload(totalBytes), {
      signal: controller.signal,
      onProgress: (sent) => {
        if (sent >= abortAt && !controller.signal.aborted) {
          reportedAtAbort = sent;
          abortedAt = Date.now();
          controller.abort();
        }
      },
    })
    .then(
      () => 'resolved',
      (error: unknown) => (error as { code?: string }).code ?? String(error)
    );
  const rejectedAfterMs = Date.now() - abortedAt;
  const received = await settledCounter(peripheral, totalBytes);
  return { code, rejectedAfterMs, reportedAtAbort, received, total: totalBytes };
}
