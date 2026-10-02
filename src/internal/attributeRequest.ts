import { BleError } from '../errors';
import type { OpOptions, SubscribeOptions, WriteOptions } from '../types';
import { normalizeUUID } from '../uuid';

/** Plan §4.9: every GATT operation has a timeout, 10 s unless the call says otherwise. */
export const DEFAULT_OPERATION_TIMEOUT_MS = 10_000;

/** What the native read, write and descriptor functions take. */
export interface NativeAttributeRequest {
  service: string;
  characteristic: string;
  descriptor?: string;
  withResponse: boolean;
  timeoutMs: number;
  /** Set when an `AbortSignal` may cancel the operation; see `cancelOperation`. */
  operationId?: number;
}

function invalid(option: string, problem: string): BleError {
  return new BleError('INVALID_ARGUMENT', `Invalid ${option}: ${problem}`);
}

/** Validates an operation's timeout; the default applies when it is missing. */
export function operationTimeout(
  options: OpOptions | undefined,
  fallback = DEFAULT_OPERATION_TIMEOUT_MS
): number {
  const timeoutMs = options?.timeoutMs;
  if (timeoutMs === undefined) {
    return fallback;
  }
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw invalid('timeoutMs', 'expected a number of milliseconds above 0');
  }
  return timeoutMs;
}

/** Builds the native request for an attribute operation (plan §5.4). Throws INVALID_ARGUMENT. */
export function toNativeAttributeRequest(
  service: string | number,
  characteristic: string | number,
  descriptor: string | number | undefined,
  options: WriteOptions = {}
): NativeAttributeRequest {
  if (options.withResponse !== undefined && typeof options.withResponse !== 'boolean') {
    throw invalid('withResponse', 'expected a boolean');
  }
  return {
    service: normalizeUUID(service),
    characteristic: normalizeUUID(characteristic),
    ...(descriptor !== undefined && { descriptor: normalizeUUID(descriptor) }),
    withResponse: options.withResponse ?? true,
    timeoutMs: operationTimeout(options),
  };
}

/** Attribute values are bytes end to end (Appendix B rule 6). */
export function checkValue(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw invalid('value', 'expected a Uint8Array');
  }
  if (value.length > 512) {
    throw new BleError(
      'INVALID_ATTRIBUTE_LENGTH',
      `${value.length} bytes is more than the 512 allowed`
    );
  }
  return value;
}

export type NativeSubscribeMode = 'auto' | 'notify' | 'indicate';

/** Validates `SubscribeOptions.mode` (plan §5.4); 'auto' when missing. */
export function subscribeMode(options: SubscribeOptions = {}): NativeSubscribeMode {
  const { mode = 'auto' } = options;
  if (mode !== 'auto' && mode !== 'notify' && mode !== 'indicate') {
    throw invalid('mode', "expected 'auto', 'notify' or 'indicate'");
  }
  return mode;
}
