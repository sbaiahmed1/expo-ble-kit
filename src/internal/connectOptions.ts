import { BleError } from '../errors';
import type { ConnectOptions } from '../types';

export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/** What the native `connect` takes. `timeoutMs` null means no timeout, never "default". */
export interface NativeConnectOptions {
  timeoutMs: number | null;
  android: { autoConnect?: boolean };
  ios: { notifyOnDisconnection: boolean };
}

function invalid(option: string, problem: string): BleError {
  return new BleError('INVALID_ARGUMENT', `Invalid connect option ${option}: ${problem}`);
}

function optionalBoolean(option: string, value: unknown): boolean | undefined {
  if (value !== undefined && typeof value !== 'boolean') {
    throw invalid(option, 'expected a boolean');
  }
  return value;
}

/**
 * Validates the connect options implemented so far (plan §5.4). Throws a BleError with code
 * INVALID_ARGUMENT. `autoDiscover`, `reconnect`, `keepAliveInBackground`, `android.requestMtu`,
 * `android.phy` and `ios.enableAutoReconnect` land with P1-06, P2-01, P3 and P1-09.
 */
export function toNativeConnectOptions(options: ConnectOptions = {}): NativeConnectOptions {
  if (typeof options !== 'object' || options === null) {
    throw invalid('options', 'expected an object');
  }
  const { timeoutMs } = options;
  if (
    timeoutMs !== undefined &&
    timeoutMs !== null &&
    (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
  ) {
    throw invalid('timeoutMs', 'expected a number of milliseconds above 0, or null for no timeout');
  }
  const autoConnect = optionalBoolean('android.autoConnect', options.android?.autoConnect);
  return {
    timeoutMs: timeoutMs === undefined ? DEFAULT_CONNECT_TIMEOUT_MS : timeoutMs,
    android: autoConnect === undefined ? {} : { autoConnect },
    ios: {
      notifyOnDisconnection:
        optionalBoolean('ios.notifyOnDisconnection', options.ios?.notifyOnDisconnection) ?? false,
    },
  };
}
