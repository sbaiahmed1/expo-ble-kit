import { Platform } from 'react-native';

import { BleError } from '../errors';
import type { ConnectOptions, ReconnectPolicy } from '../types';

export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
/** Discovery is one queued operation, slower than the 10 s default (plan §4.9). */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 30_000;
/** The ATT MTU range (plan §5.4). 23 is the default every connection starts with. */
export const MIN_MTU = 23;
export const MAX_MTU = 517;
/** Android asks for this after connecting unless `android.requestMtu` says otherwise (Q3). */
export const DEFAULT_REQUESTED_MTU = 517;
/** Plan §4.9: Android resets a connection after this many operations in a row time out. */
export const DEFAULT_RESET_AFTER_TIMEOUTS = 2;

/** A `ReconnectPolicy` with the defaults applied; `maxAttempts` null means no limit. */
export interface NativeReconnectPolicy {
  maxAttempts: number | null;
  initialDelayMs: number;
  maxDelayMs: number;
  backoff: 'exponential' | 'fixed';
}

/** What the native `connect` takes. `timeoutMs` null means no timeout, never "default". */
export interface NativeConnectOptions {
  timeoutMs: number | null;
  autoDiscover: boolean;
  /** Null: no reconnection (P2-01). */
  reconnect: NativeReconnectPolicy | null;
  restoreSubscriptionsOnReconnect: boolean;
  /** Android: run the foreground service until the connection ends (P3-03). */
  keepAliveInBackground: boolean;
  /** `requestMtu` null asks for no MTU exchange; `resetAfterTimeouts` null never resets. */
  android: { autoConnect?: boolean; requestMtu: number | null; resetAfterTimeouts: number | null };
  ios: { notifyOnDisconnection: boolean; enableAutoReconnect: boolean };
}

export const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 1_000;
export const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;

/** The wait before reconnection attempt `attempt` (1-based), as the native cores compute it. */
export function reconnectDelay(policy: NativeReconnectPolicy, attempt: number): number {
  if (policy.backoff === 'fixed') return policy.initialDelayMs;
  return Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** Math.min(attempt - 1, 20));
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

function delay(option: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw invalid(option, 'expected a number of milliseconds, 0 or more');
  }
  return value;
}

/** Validates `reconnect` (plan §5.4) and applies its defaults; null when it is unset or false. */
function toNativeReconnectPolicy(
  value: ReconnectPolicy | false | undefined
): NativeReconnectPolicy | null {
  if (value === undefined || value === false) return null;
  if (typeof value !== 'object' || value === null) {
    throw invalid('reconnect', 'expected a ReconnectPolicy object or false');
  }
  const { maxAttempts = Infinity, backoff = 'exponential' } = value;
  if (maxAttempts !== Infinity && (!Number.isInteger(maxAttempts) || maxAttempts < 1)) {
    throw invalid('reconnect.maxAttempts', 'expected an integer of 1 or more, or Infinity');
  }
  if (backoff !== 'exponential' && backoff !== 'fixed') {
    throw invalid('reconnect.backoff', "expected 'exponential' or 'fixed'");
  }
  const initialDelayMs = delay(
    'reconnect.initialDelayMs',
    value.initialDelayMs,
    DEFAULT_RECONNECT_INITIAL_DELAY_MS
  );
  const maxDelayMs = delay(
    'reconnect.maxDelayMs',
    value.maxDelayMs,
    Math.max(DEFAULT_RECONNECT_MAX_DELAY_MS, initialDelayMs)
  );
  if (maxDelayMs < initialDelayMs) {
    throw invalid('reconnect.maxDelayMs', 'expected at least reconnect.initialDelayMs');
  }
  return {
    maxAttempts: maxAttempts === Infinity ? null : maxAttempts,
    initialDelayMs,
    maxDelayMs,
    backoff,
  };
}

/**
 * Options of later tasks (plan §7): `keepAliveInBackground` on iOS (P3-01), `android.phy` (P5-02).
 * Setting one rejects with NOT_SUPPORTED rather than being ignored; platform options only on their
 * platform.
 */
function checkImplemented(options: ConnectOptions): void {
  if (
    optionalBoolean('keepAliveInBackground', options.keepAliveInBackground) &&
    Platform.OS === 'ios'
  ) {
    throw new BleError(
      'NOT_SUPPORTED',
      "Connect option keepAliveInBackground isn't supported on iOS yet: it comes with background modes"
    );
  }
  const phy: unknown = options.android?.phy;
  if (phy !== undefined && !Array.isArray(phy)) {
    throw invalid('android.phy', 'expected an array');
  }
  if (Platform.OS === 'android' && Array.isArray(phy) && phy.length > 0) {
    throw notYet('android.phy');
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
  const resetAfterTimeouts = options.android?.resetAfterTimeouts;
  if (
    resetAfterTimeouts !== undefined &&
    resetAfterTimeouts !== false &&
    (!Number.isInteger(resetAfterTimeouts) || resetAfterTimeouts < 1)
  ) {
    throw invalid('android.resetAfterTimeouts', 'expected an integer of 1 or more, or false');
  }
  const reconnect = toNativeReconnectPolicy(options.reconnect);
  const restoreSubscriptionsOnReconnect = optionalBoolean(
    'restoreSubscriptionsOnReconnect',
    options.restoreSubscriptionsOnReconnect
  );
  const enableAutoReconnect = optionalBoolean(
    'ios.enableAutoReconnect',
    options.ios?.enableAutoReconnect
  );
  if (enableAutoReconnect && !reconnect) {
    throw invalid(
      'ios.enableAutoReconnect',
      'needs reconnect, the policy used when iOS stops reconnecting'
    );
  }
  return {
    timeoutMs: timeoutMs === undefined ? DEFAULT_CONNECT_TIMEOUT_MS : timeoutMs,
    autoDiscover: optionalBoolean('autoDiscover', options.autoDiscover) ?? true,
    reconnect,
    restoreSubscriptionsOnReconnect: restoreSubscriptionsOnReconnect ?? true,
    keepAliveInBackground: options.keepAliveInBackground === true,
    android: {
      ...(autoConnect === undefined ? {} : { autoConnect }),
      requestMtu:
        requestMtu === undefined
          ? DEFAULT_REQUESTED_MTU
          : requestMtu === false
            ? null
            : validateMtu('android.requestMtu', requestMtu),
      resetAfterTimeouts:
        resetAfterTimeouts === undefined
          ? DEFAULT_RESET_AFTER_TIMEOUTS
          : resetAfterTimeouts === false
            ? null
            : resetAfterTimeouts,
    },
    ios: {
      notifyOnDisconnection:
        optionalBoolean('ios.notifyOnDisconnection', options.ios?.notifyOnDisconnection) ?? false,
      enableAutoReconnect: enableAutoReconnect ?? false,
    },
  };
}
