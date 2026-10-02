import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { BleManager } from '../BleManager';
import { BleError } from '../errors';
import type { ConnectionState, Peripheral } from '../types';

const noop = () => {};

/** The connection state of `peripheral`, re-rendering on every change. */
export function useConnectionState(peripheral: Peripheral | null): ConnectionState {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!peripheral) {
        return noop;
      }
      const listener = peripheral.addConnectionStateListener(onChange);
      return () => listener.remove();
    },
    [peripheral]
  );
  return useSyncExternalStore(subscribe, () => peripheral?.state ?? 'disconnected');
}

/**
 * The peripheral for `id` (null for null), its connection state, and the error that ended or failed
 * its last connection, cleared once it connects again (plan §5.7). Doesn't connect by itself.
 */
export function usePeripheral(id: string | null): {
  /** The peripheral for `id`; null for a null or invalid id. */
  peripheral: Peripheral | null;
  /** Its connection state. */
  state: ConnectionState;
  /** Why the last connection ended or failed, or why the id is invalid. */
  error: BleError | null;
} {
  // An invalid id is reported as the error instead of throwing during render.
  const resolved = useMemo(() => {
    if (id === null) {
      return { peripheral: null, error: null };
    }
    try {
      return { peripheral: BleManager.getPeripheral(id), error: null };
    } catch (thrown) {
      return { peripheral: null, error: BleError.fromNative(thrown) };
    }
  }, [id]);
  const { peripheral } = resolved;
  const state = useConnectionState(peripheral);
  // Kept with its peripheral, so another id starts without an error.
  const [failure, setFailure] = useState<{ peripheral: Peripheral; error: BleError } | null>(null);

  useEffect(() => {
    if (!peripheral) {
      return;
    }
    const listener = peripheral.addConnectionStateListener((next, error) => {
      if (error) {
        setFailure({ peripheral, error });
      } else if (next === 'connected') {
        setFailure(null);
      }
    });
    return () => listener.remove();
  }, [peripheral]);

  const connectionError = failure?.peripheral === peripheral ? failure.error : null;
  return { peripheral, state, error: resolved.error ?? connectionError };
}
