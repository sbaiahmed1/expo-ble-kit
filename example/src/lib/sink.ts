import type { Peripheral } from 'expo-ble-kit';

import { TestProfile } from './gattNames';

// P2-02 acceptance: bytes sent to the test peripheral through repeated writes without response
// arrive complete. SINK_NO_RSP discards what it receives and counts it in SINK_COUNTER.

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

/**
 * Resets the counters (and checks SINK_COUNTER reads 0), sends `totalBytes` to SINK_NO_RSP in
 * packets of MTU − 3 bytes without response, then reads SINK_COUNTER until it reaches the total or
 * stops growing (packets the stack took may still be on their way). Rejects with the first failed
 * write.
 */
export async function sendToSink(
  peripheral: Peripheral,
  totalBytes: number,
  onProgress?: (sent: number) => void
): Promise<SinkReport> {
  await peripheral.write(TestProfile.TEST, TestProfile.CONTROL, RESET_COUNTERS);
  for (let polls = 0; (await readSinkCounter(peripheral)) !== 0; polls++) {
    if (polls === 10) throw new Error('SINK_COUNTER did not reset');
    await sleep(100);
  }
  const packetSize = peripheral.mtu - 3;
  const inFlight = new Set<Promise<void>>();
  let failure: unknown = null;
  let sent = 0;
  const started = Date.now();
  while (sent < totalBytes && failure === null) {
    const packet = Uint8Array.from({ length: Math.min(packetSize, totalBytes - sent) }, (_, i) => {
      return (sent + i) % 256;
    });
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

  let received = await readSinkCounter(peripheral);
  for (let still = 0; received < sent && still < 5;) {
    await sleep(200);
    const next = await readSinkCounter(peripheral);
    still = next === received ? still + 1 : 0;
    received = next;
  }
  return { sent, received, packetSize, ms };
}
