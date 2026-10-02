import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { BleManager } from '../BleManager';
import type { BlePermissionRequest, BlePermissions } from '../types';
import { useBleState } from './useBleState';

/**
 * The permissions, null until first read, and a function that requests them (plan §5.7). They are
 * read again when the adapter state changes and when the app returns to the foreground, since the
 * user may have changed them in Settings. Reading never shows a prompt; a read that fails (for
 * example MISCONFIGURED) leaves the last value.
 */
export function useBlePermissions(): [
  BlePermissions | null,
  (request?: BlePermissionRequest) => Promise<BlePermissions>,
] {
  const [permissions, setPermissions] = useState<BlePermissions | null>(null);
  const state = useBleState();
  const mounted = useRef(true);
  const [foregrounds, setForegrounds] = useState(0);

  useEffect(() => {
    mounted.current = true;
    const listener = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        setForegrounds((count) => count + 1);
      }
    });
    return () => {
      mounted.current = false;
      listener.remove();
    };
  }, []);

  useEffect(() => {
    let current = true;
    BleManager.getPermissionsAsync().then(
      (read) => current && setPermissions(read),
      () => {}
    );
    return () => {
      current = false;
    };
  }, [state, foregrounds]);

  const request = useCallback(async (options?: BlePermissionRequest) => {
    const granted = await BleManager.requestPermissionsAsync(options);
    if (mounted.current) {
      setPermissions(granted);
    }
    return granted;
  }, []);

  return [permissions, request];
}
