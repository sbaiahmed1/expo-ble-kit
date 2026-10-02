import { useEffect, useMemo, useState } from 'react';

import { BleError } from '../errors';
import type { CharacteristicSubscription, Peripheral } from '../types';
import { normalizeUUID, type UUID } from '../uuid';
import { useConnectionState } from './usePeripheral';

type Target = { service: UUID; characteristic: UUID } | { invalid: BleError };

interface Snapshot {
  /** What the value belongs to: the peripheral, the characteristic and the mode. */
  key: string;
  value: Uint8Array | null;
  error: BleError | null;
}

/**
 * The value of a characteristic while `peripheral` is connected (plan §5.7). `mode: 'subscribe'`
 * (default) follows its notifications or indications; `mode: 'read'` reads it once per connection.
 * `batchMs` renders at most once per window, with the latest value. The last value is kept across
 * disconnects, and the subscription or read starts again after a reconnect.
 */
export function useCharacteristicValue(
  peripheral: Peripheral | null,
  service: UUID,
  characteristic: UUID,
  options: { mode?: 'subscribe' | 'read'; batchMs?: number } = {}
): {
  /** The latest value; null until the first one. */
  value: Uint8Array | null;
  /** Why subscribing or reading failed. */
  error: BleError | null;
} {
  const { mode = 'subscribe', batchMs = 0 } = options;
  const connected = useConnectionState(peripheral) === 'connected';
  const target = useMemo((): Target => {
    try {
      return { service: normalizeUUID(service), characteristic: normalizeUUID(characteristic) };
    } catch (thrown) {
      return { invalid: BleError.fromNative(thrown) };
    }
  }, [service, characteristic]);
  const key =
    'invalid' in target
      ? ''
      : `${peripheral?.id ?? ''}|${target.service}|${target.characteristic}|${mode}`;
  const [snapshot, setSnapshot] = useState<Snapshot>({ key, value: null, error: null });

  useEffect(() => {
    if ('invalid' in target || !peripheral || !connected) {
      return;
    }
    let current = true;
    let subscription: CharacteristicSubscription | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let latest: Uint8Array | null = null;
    const update = (change: Partial<Omit<Snapshot, 'key'>>) => {
      if (current) {
        setSnapshot((previous) => ({
          ...(previous.key === key ? previous : { key, value: null, error: null }),
          ...change,
        }));
      }
    };
    const fail = (thrown: unknown) => update({ error: BleError.fromNative(thrown) });
    const show = (value: Uint8Array) => {
      if (batchMs <= 0) {
        update({ value });
        return;
      }
      latest = value;
      timer ??= setTimeout(() => {
        timer = null;
        update({ value: latest });
      }, batchMs);
    };

    if (mode === 'read') {
      peripheral
        .read(target.service, target.characteristic)
        .then((value) => update({ value, error: null }), fail);
    } else {
      peripheral.subscribe(target.service, target.characteristic, show).then((subscribed) => {
        if (current) {
          subscription = subscribed;
          update({ error: null });
        } else {
          subscribed.remove();
        }
      }, fail);
    }
    return () => {
      current = false;
      subscription?.remove();
      if (timer) clearTimeout(timer);
    };
  }, [peripheral, connected, target, key, mode, batchMs]);

  if ('invalid' in target) {
    return { value: null, error: target.invalid };
  }
  const own = snapshot.key === key ? snapshot : null;
  return { value: own?.value ?? null, error: own?.error ?? null };
}
