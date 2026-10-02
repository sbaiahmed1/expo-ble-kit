import { useCallback, useEffect, useMemo, useState } from 'react';

import { BleManager } from '../BleManager';
import { BleError, BleErrorCode } from '../errors';
import { toNativeScanOptions } from '../internal/scanOptions';
import type { ScanOptions, ScanResult, ScanSession } from '../types';
import { useBleState } from './useBleState';

/** How many devices `useScan` keeps unless `maxResults` says otherwise. */
export const DEFAULT_MAX_RESULTS = 100;

interface Entry {
  result: ScanResult;
  /** Order of the last sighting. */
  seen: number;
}

/** The latest result per device, in order of first sighting; the least recently seen go first. */
function merge(entries: Entry[], batch: ScanResult[], max: number): Entry[] {
  let tick = entries.reduce((latest, entry) => Math.max(latest, entry.seen), 0);
  const next = [...entries];
  for (const result of batch) {
    tick += 1;
    const index = next.findIndex((entry) => entry.result.id === result.id);
    if (index >= 0) {
      next[index] = { result, seen: tick };
    } else {
      next.push({ result, seen: tick });
    }
  }
  while (next.length > max) {
    let oldest = 0;
    next.forEach((entry, index) => {
      if (entry.seen < next[oldest].seen) oldest = index;
    });
    next.splice(oldest, 1);
  }
  return next;
}

/** A stable key for the options, so an inline object doesn't restart the scan on every render. */
function optionsKey(options: ScanOptions): string {
  return JSON.stringify(options, (_, value) =>
    value instanceof Uint8Array ? Array.from(value) : value
  );
}

/** Option errors, found while rendering rather than when the scan starts. */
function optionsError(options: ScanOptions, maxResults: number): BleError | null {
  if (!Number.isInteger(maxResults) || maxResults < 1) {
    return new BleError(BleErrorCode.INVALID_ARGUMENT, 'Invalid maxResults: expected 1 or more');
  }
  try {
    toNativeScanOptions(options);
    return null;
  } catch (thrown) {
    return BleError.fromNative(thrown);
  }
}

/**
 * Scans while `enabled` (default true) and gives the latest result per device (plan §5.7), at most
 * `maxResults` (default 100; the least recently seen device makes room). `start()` and `stop()`
 * override `enabled` until it changes. A scan that ended because Bluetooth went off or wasn't
 * allowed starts again when the adapter is back to `poweredOn`. Changing the options restarts it.
 */
export function useScan(options: ScanOptions & { enabled?: boolean; maxResults?: number } = {}): {
  /** The latest result per device, in order of first sighting. */
  results: ScanResult[];
  /** Whether the scan runs now. */
  isScanning: boolean;
  /** Why the scan isn't running: invalid options, Bluetooth off, a missing permission… */
  error: BleError | null;
  /** Starts scanning (again), whatever `enabled` says, until `enabled` changes. */
  start(): void;
  /** Stops scanning, whatever `enabled` says, until `enabled` changes. */
  stop(): void;
  /** Empties `results`. */
  clear(): void;
} {
  const { enabled = true, maxResults = DEFAULT_MAX_RESULTS, ...scanOptions } = options;
  const key = optionsKey(scanOptions);

  // State adjusted while rendering (no effect): the options for this key, and `enabled` changes.
  const [stable, setStable] = useState({ key, options: scanOptions });
  if (stable.key !== key) {
    setStable({ key, options: scanOptions });
  }
  const [wanted, setWanted] = useState(enabled);
  const [lastEnabled, setLastEnabled] = useState(enabled);
  if (enabled !== lastEnabled) {
    setLastEnabled(enabled);
    setWanted(enabled);
  }

  const [entries, setEntries] = useState<Entry[]>([]);
  const [restarts, setRestarts] = useState(0);
  const poweredOn = useBleState() === 'poweredOn';
  const invalid = useMemo(
    () => optionsError(stable.options, maxResults),
    [stable.options, maxResults]
  );
  // Each start is a run; how a run ended only counts while it is the current one.
  const run = `${key}|${maxResults}|${poweredOn}|${restarts}`;
  const [ended, setEnded] = useState<{ run: string; error: BleError } | null>(null);

  useEffect(() => {
    if (!wanted || invalid) {
      return;
    }
    let session: ScanSession | null = null;
    const end = (error: BleError) => setEnded({ run, error });
    try {
      session = BleManager.startScan(
        stable.options,
        (batch) => setEntries((current) => merge(current, batch, maxResults)),
        end
      );
    } catch (thrown) {
      // Reported like an asynchronous failure (for example a missing native module).
      Promise.resolve().then(() => end(BleError.fromNative(thrown)));
    }
    return () => session?.stop();
  }, [wanted, invalid, stable.options, maxResults, run]);

  const endedHere = ended?.run === run ? ended.error : null;
  const isScanning = wanted && !invalid && !endedHere;
  const start = useCallback(() => {
    setWanted(true);
    if (!isScanning) {
      setRestarts((count) => count + 1);
    }
  }, [isScanning]);
  const stop = useCallback(() => setWanted(false), []);
  const clear = useCallback(() => setEntries([]), []);
  const results = useMemo(() => entries.map((entry) => entry.result), [entries]);

  return { results, isScanning, error: invalid ?? endedHere, start, stop, clear };
}
