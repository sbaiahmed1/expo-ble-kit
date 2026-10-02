import { useSyncExternalStore } from 'react';

import { BleManager } from '../BleManager';
import type { BleState } from '../types';

function subscribe(onChange: () => void): () => void {
  const listener = BleManager.addStateListener(onChange);
  return () => listener.remove();
}

function getState(): BleState {
  return BleManager.state;
}

/** The adapter state, re-rendering on every change (plan §5.7). */
export function useBleState(): BleState {
  return useSyncExternalStore(subscribe, getState);
}
