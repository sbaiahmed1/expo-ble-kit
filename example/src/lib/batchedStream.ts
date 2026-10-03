import type { NotificationBatch, Peripheral } from 'expo-ble-kit';

import { TestProfile } from './gattNames';
import { resetCounters } from './sink';

// P2-04 acceptance: the test peripheral streams 100 Hz × 20 B frames (CONTROL SET_STREAM) to a
// batched subscription with intervalMs 16: at most ~63 JS events per second, nothing dropped, no
// sequence gaps. Each frame starts with its uint32 LE sequence number (profile.json stream.frame).

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type BatchedStreamReport = {
  seconds: number;
  frames: number;
  /** Frames missing from the sequence. */
  gaps: number;
  /** Values the batches reported as dropped. */
  dropped: number;
  batches: number;
  batchesPerSecond: number;
  /** The most frames one batch held. */
  largestBatch: number;
  /** At most 63 batches/s, no gaps, nothing dropped. */
  ok: boolean;
};

function setStream(rateHz: number, frameSize: number): Uint8Array {
  return Uint8Array.of(0x01, rateHz & 0xff, rateHz >> 8, frameSize & 0xff, frameSize >> 8);
}

/** Streams for `seconds`, calling `onUpdate` about every second with the figures so far. */
export async function runBatchedStream(
  peripheral: Peripheral,
  options: {
    seconds: number;
    rateHz?: number;
    frameSize?: number;
    intervalMs?: number;
    onUpdate?: (report: BatchedStreamReport) => void;
    signal?: AbortSignal;
  }
): Promise<BatchedStreamReport> {
  const { seconds, rateHz = 100, frameSize = 20, intervalMs = 16, onUpdate, signal } = options;
  await resetCounters(peripheral);
  let frames = 0;
  let gaps = 0;
  let dropped = 0;
  let batches = 0;
  let largestBatch = 0;
  let expected = 0;
  const onBatch = (batch: NotificationBatch) => {
    batches++;
    dropped += batch.dropped;
    largestBatch = Math.max(largestBatch, batch.values.length);
    for (const value of batch.values) {
      const sequence = new DataView(value.buffer, value.byteOffset, 4).getUint32(0, true);
      if (sequence > expected) gaps += sequence - expected;
      expected = sequence + 1;
      frames++;
    }
  };
  const report = (elapsed: number): BatchedStreamReport => {
    const batchesPerSecond = elapsed > 0 ? batches / elapsed : 0;
    const ok = batchesPerSecond <= 63 && gaps === 0 && dropped === 0 && frames > 0;
    return { seconds: elapsed, frames, gaps, dropped, batches, batchesPerSecond, largestBatch, ok };
  };

  const subscription = await peripheral.subscribeBatched(
    TestProfile.TEST,
    TestProfile.STREAM,
    onBatch,
    {
      intervalMs,
    }
  );
  const started = Date.now();
  try {
    await peripheral.write(TestProfile.TEST, TestProfile.CONTROL, setStream(rateHz, frameSize));
    for (let second = 1; second <= seconds && !signal?.aborted; second++) {
      await sleep(Math.max(0, started + second * 1000 - Date.now()));
      onUpdate?.(report((Date.now() - started) / 1000));
    }
    const elapsed = (Date.now() - started) / 1000;
    await peripheral.write(TestProfile.TEST, TestProfile.CONTROL, setStream(0, frameSize));
    // Frames already on their way still arrive and are counted.
    await sleep(200);
    return report(elapsed);
  } finally {
    await subscription.unsubscribe().catch(() => {});
  }
}

/** `Batched stream OK: 30 s, 3000 frames, 0 gaps, 0 dropped, 62.4 batches/s (largest 3)`. */
export function describeBatchedStream(report: BatchedStreamReport, done = true): string {
  const verdict = done ? (report.ok ? 'OK' : 'FAILED') : 'running';
  return (
    `Batched stream ${verdict}: ${Math.round(report.seconds)} s, ${report.frames} frames, ` +
    `${report.gaps} gaps, ${report.dropped} dropped, ${report.batchesPerSecond.toFixed(1)} batches/s ` +
    `(largest ${report.largestBatch})`
  );
}
