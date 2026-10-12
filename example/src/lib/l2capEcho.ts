import { BleError, BleManager, type L2CAPServer, type Peripheral } from 'expo-ble-kit';

import { TestProfile } from './gattNames';

// P5-03: an L2CAP echo. The central sends `bytes` while the peripheral sends every byte back, so
// the same amount crosses the link in each direction at once (the task's acceptance: 1 MB). The
// peripheral side is the test profile's echo server (profile.json l2cap.echo): the Bumble
// peripheral, or a phone's Peripheral tab, which tells its PSM in L2CAP_PSM.

/** The acceptance's transfer: 1 MB each way. */
export const ECHO_BYTES = 1024 * 1024;
/** Bytes per write: the native side hands them to the stack in packets of the channel's size. */
const WRITE_SIZE = 16 * 1024;

export type EchoReport = {
  psm: number;
  bytes: number;
  /** Until the last write resolved. */
  sentMs: number;
  /** Until the last byte came back. */
  echoedMs: number;
  ok: boolean;
};

/** The deterministic bytes the echo sends (profile.json patterns: i * 31 + 7, modulo 251). */
export function echoPattern(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 31 + 7) % 251);
}

/** The echo server's PSM from L2CAP_PSM (uint16 LE). */
export async function readEchoPsm(device: Peripheral): Promise<number> {
  const value = await device.read(TestProfile.TEST, TestProfile.L2CAP_PSM);
  if (value.length < 2) {
    throw new BleError(
      'INVALID_ATTRIBUTE_LENGTH',
      `L2CAP_PSM has ${value.length} bytes, expected 2`
    );
  }
  return value[0] | (value[1] << 8);
}

/**
 * Opens a channel to the echo server of a connected test peripheral and sends `bytes`, awaiting
 * each write (the stack paces them), while the echo comes back. Rejects when the channel closes
 * early or the echo isn't complete within `timeoutMs`.
 */
export async function runL2capEcho(
  device: Peripheral,
  options: { bytes?: number; psm?: number; timeoutMs?: number } = {}
): Promise<EchoReport> {
  const { bytes = ECHO_BYTES, timeoutMs = 120_000 } = options;
  const psm = options.psm ?? (await readEchoPsm(device));
  // Insecure on Android, so phones that never paired don't have to (iOS: the server decides).
  const channel = await device.openL2CAPChannel(psm, { android: { secure: false } });
  const data = echoPattern(bytes);
  const received = new Uint8Array(bytes);
  let receivedLength = 0;
  let overflow = 0;
  const start = Date.now();
  try {
    const echoed = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new BleError(
              'OPERATION_TIMEOUT',
              `Echo incomplete: ${receivedLength} of ${bytes} bytes back`
            )
          ),
        timeoutMs
      );
      channel.addCloseListener((error) => {
        clearTimeout(timer);
        reject(
          error ??
            new BleError(
              'L2CAP_FAILED',
              `The channel closed after ${receivedLength} of ${bytes} bytes`
            )
        );
      });
      channel.addDataListener((chunk) => {
        const fits = Math.min(chunk.length, bytes - receivedLength);
        received.set(chunk.subarray(0, fits), receivedLength);
        overflow += chunk.length - fits;
        receivedLength += fits;
        if (receivedLength === bytes) {
          clearTimeout(timer);
          resolve(Date.now() - start);
        }
      });
    });
    echoed.catch(() => {});
    for (let offset = 0; offset < bytes; offset += WRITE_SIZE) {
      await channel.write(data.subarray(offset, offset + WRITE_SIZE));
    }
    const sentMs = Date.now() - start;
    const echoedMs = await echoed;
    const ok = overflow === 0 && received.every((byte, i) => byte === data[i]);
    return { psm, bytes, sentMs, echoedMs, ok };
  } finally {
    await channel.close().catch(() => {});
  }
}

const kbPerSecond = (bytes: number, ms: number) =>
  Math.round(bytes / 1024 / Math.max(ms / 1000, 0.001));

/** `1024 KB each way over PSM 0x81: sent in 4.2 s (243 KB/s), echoed in 4.5 s (227 KB/s)`. */
export function describeEcho(report: EchoReport): string {
  const size = `${Math.round(report.bytes / 1024)} KB each way over PSM 0x${report.psm.toString(16)}`;
  const timing =
    `sent in ${(report.sentMs / 1000).toFixed(1)} s (${kbPerSecond(report.bytes, report.sentMs)} KB/s), ` +
    `echoed in ${(report.echoedMs / 1000).toFixed(1)} s (${kbPerSecond(report.bytes, report.echoedMs)} KB/s)`;
  return report.ok ? `${size}: ${timing}` : `${size}: the echo differs from what was sent`;
}

/**
 * The test profile's echo server on this phone: every byte a central sends comes back on the same
 * channel. Insecure, so the two phones don't have to pair.
 */
export async function startEchoServer(onLine?: (line: string) => void): Promise<L2CAPServer> {
  const server = await BleManager.publishL2CAPChannel({ secure: false });
  server.addChannelListener((channel) => {
    const peer = channel.peerId.slice(-5);
    let echoed = 0;
    onLine?.(`L2CAP channel from ${peer}`);
    channel.addDataListener((data) => {
      channel.write(data).then(
        () => (echoed += data.length),
        () => {}
      );
    });
    channel.addCloseListener((error) =>
      onLine?.(
        `L2CAP channel from ${peer} closed after ${echoed} bytes${error ? `: ${error.code}` : ''}`
      )
    );
  });
  return server;
}
