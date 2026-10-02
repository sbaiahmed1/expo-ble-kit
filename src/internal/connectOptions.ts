import { Platform } from 'react-native';

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

function notYet(option: string): BleError {
  return new BleError('NOT_SUPPORTED', `Connect option ${option} isn't supported yet`);
}

/**
 * Options of later tasks (plan §7): `reconnect` and `ios.enableAutoReconnect` (P2-01),
 * `keepAliveInBackground` (P3-03), `android.phy` (P5-02). Setting one rejects with NOT_SUPPORTED
 * rather than being ignored; platform options only on their platform.
 */
function checkImplemented(options: ConnectOptions): void {
  if (options.reconnect !== undefined && options.reconnect !== false) {
    throw notYet('reconnect');
  }
  optionalBoolean('restoreSubscriptionsOnReconnect', options.restoreSubscriptionsOnReconnect);
  if (optionalBoolean('keepAliveInBackground', options.keepAliveInBackground)) {
    throw notYet('keepAliveInBackground');
  }
  const phy: unknown = options.android?.phy;
  if (phy !== undefined && !Array.isArray(phy)) {
    throw invalid('android.phy', 'expected an array');
  }
  if (Platform.OS === 'android' && Array.isArray(phy) && phy.length > 0) {
    throw notYet('android.phy');
  }
  const autoReconnect = optionalBoolean(
    'ios.enableAutoReconnect',
    options.ios?.enableAutoReconnect
  );
  if (Platform.OS === 'ios' && autoReconnect) {
    throw notYet('ios.enableAutoReconnect');
  }
}

/**
 * Validates connect options (plan §5.4) and applies the defaults. Throws a BleError with code
 * INVALID_ARGUMENT, or NOT_SUPPORTED for an option a later task implements.
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
  checkImplemented(options);
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
