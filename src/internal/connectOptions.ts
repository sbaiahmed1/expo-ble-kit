import { BleError } from '../errors';
import type { ConnectOptions } from '../types';

export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
/** Discovery is one queued operation, slower than the 10 s default (plan §4.9). */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 30_000;
/** The ATT MTU range (plan §5.4). 23 is the default every connection starts with. */
export const MIN_MTU = 23;
export const MAX_MTU = 517;
/** Android asks for this after connecting unless `android.requestMtu` says otherwise (Q3). */
export const DEFAULT_REQUESTED_MTU = 517;

/** What the native `connect` takes. `timeoutMs` null means no timeout, never "default". */
export interface NativeConnectOptions {
  timeoutMs: number | null;
  autoDiscover: boolean;
  /** `requestMtu` null asks for no MTU exchange. */
  android: { autoConnect?: boolean; requestMtu: number | null };
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

/** An integer MTU in 23–517, or a BleError with code INVALID_ARGUMENT naming `option`. */
export function validateMtu(option: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_MTU || value > MAX_MTU) {
    throw invalid(option, `expected an integer from ${MIN_MTU} to ${MAX_MTU}`);
  }
  return value;
}

/**
 * Validates the connect options implemented so far (plan §5.4). Throws a BleError with code
 * INVALID_ARGUMENT. `reconnect`, `keepAliveInBackground`, `android.phy` and
 * `ios.enableAutoReconnect` land with P2-01 and P3.
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
  const requestMtu = options.android?.requestMtu;
  return {
    timeoutMs: timeoutMs === undefined ? DEFAULT_CONNECT_TIMEOUT_MS : timeoutMs,
    autoDiscover: optionalBoolean('autoDiscover', options.autoDiscover) ?? true,
    android: {
      ...(autoConnect === undefined ? {} : { autoConnect }),
      requestMtu:
        requestMtu === undefined
          ? DEFAULT_REQUESTED_MTU
          : requestMtu === false
            ? null
            : validateMtu('android.requestMtu', requestMtu),
    },
    ios: {
      notifyOnDisconnection:
        optionalBoolean('ios.notifyOnDisconnection', options.ios?.notifyOnDisconnection) ?? false,
    },
  };
}
