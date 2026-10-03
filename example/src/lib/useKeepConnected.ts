import { useEffect, useState } from 'react';

import { BleError, type Peripheral } from 'expo-ble-kit';

// Keeps a peripheral connected from the app, with the backoff of a ReconnectPolicy. A stand-in for
// connect({ reconnect }), which expo-ble-kit adds in P2-01; then this hook becomes one option.

export const RECONNECT_POLICY = { maxAttempts: 5, initialDelayMs: 1000, maxDelayMs: 30_000 };

/** The wait before retry number `attempt` (1-based): 1 s, 2 s, 4 s… up to 30 s. */
export function reconnectDelay(attempt: number): number {
  return Math.min(
    RECONNECT_POLICY.initialDelayMs * 2 ** (attempt - 1),
    RECONNECT_POLICY.maxDelayMs
  );
}

export type LinkStatus =
  | { phase: 'idle' }
  | { phase: 'connecting'; attempt: number }
  | { phase: 'connected' }
  | { phase: 'waiting'; attempt: number; delayMs: number; error: BleError | null }
  | { phase: 'gaveUp'; error: BleError | null };

/**
 * While `wanted`, connects `peripheral` and reconnects it after an unexpected disconnect or a
 * failed attempt, waiting longer each time. Gives up after RECONNECT_POLICY.maxAttempts retries in
 * a row; `retryToken` changes start over. Stopping (`wanted` false) cancels a pending wait.
 * `reconnects` counts the times the link came back after it was lost.
 */
export function useKeepConnected(
  peripheral: Peripheral | null,
  wanted: boolean,
  retryToken = 0
): LinkStatus & { reconnects: number } {
  const [status, setStatus] = useState<LinkStatus>({ phase: 'idle' });
  const [reconnects, setReconnects] = useState(0);

  useEffect(() => {
    if (!peripheral || !wanted) {
      setStatus({ phase: 'idle' });
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, ms);
      });
    const untilDisconnected = () =>
      new Promise<BleError | null>((resolve) => {
        if (peripheral.state === 'disconnected') return resolve(null);
        const listener = peripheral.addConnectionStateListener((state, error) => {
          if (state === 'disconnected') {
            listener.remove();
            resolve(error ?? null);
          }
        });
        wake = () => {
          listener.remove();
          resolve(null);
        };
      });

    (async () => {
      let attempt = 0;
      let lastError: BleError | null = null;
      while (!cancelled) {
        if (attempt > RECONNECT_POLICY.maxAttempts) {
          setStatus({ phase: 'gaveUp', error: lastError });
          return;
        }
        if (attempt > 0) {
          const delayMs = reconnectDelay(attempt);
          setStatus({ phase: 'waiting', attempt, delayMs, error: lastError });
          await sleep(delayMs);
          if (cancelled) return;
        }
        setStatus({ phase: 'connecting', attempt });
        try {
          await peripheral.connect({ timeoutMs: 10_000 });
        } catch (error) {
          if (cancelled) return;
          lastError = BleError.fromNative(error);
          attempt += 1;
          continue;
        }
        if (cancelled) return;
        if (attempt > 0) setReconnects((count) => count + 1);
        setStatus({ phase: 'connected' });
        lastError = await untilDisconnected();
        attempt = 1;
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      wake?.();
    };
  }, [peripheral, wanted, retryToken]);

  return { ...status, reconnects };
}
