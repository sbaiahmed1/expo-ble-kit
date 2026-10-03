import { BleError } from '../errors';
import type {
  BatchOptions,
  OpOptions,
  StreamOptions,
  SubscribeOptions,
  WriteOptions,
} from '../types';
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
  /** Set for a batched subscribe (P2-04). */
  batch?: NativeBatch;
}

/** How a batched subscriber receives values (plan §4.10). */
export interface NativeBatch {
  intervalMs: number;
  maxItems: number;
}

/** `BatchOptions.maxItems` when the call doesn't say (plan §4.10). */
export const DEFAULT_BATCH_MAX_ITEMS = 4096;

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

/** What writeStream adds to the request (plan §5.4, P2-03). Throws INVALID_ARGUMENT. */
export function toStreamParameters(options: StreamOptions = {}): {
  withResponse: boolean;
  chunkSize: number | null;
  onProgress: ((sent: number, total: number) => void) | undefined;
} {
  const { chunkSize, onProgress } = options;
  if (chunkSize !== undefined && (!Number.isInteger(chunkSize) || chunkSize < 1)) {
    throw invalid('chunkSize', 'expected an integer of 1 or more');
  }
  if (onProgress !== undefined && typeof onProgress !== 'function') {
    throw invalid('onProgress', 'expected a function');
  }
  return { withResponse: options.withResponse ?? false, chunkSize: chunkSize ?? null, onProgress };
}

/** Validates `BatchOptions` and applies the default `maxItems` (plan §4.10). */
export function toNativeBatch(options: BatchOptions | undefined): NativeBatch {
  const intervalMs = options?.intervalMs;
  if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs) || intervalMs < 1) {
    throw invalid('intervalMs', 'expected a number of milliseconds of 1 or more');
  }
  const { maxItems = DEFAULT_BATCH_MAX_ITEMS } = options!;
  if (!Number.isInteger(maxItems) || maxItems < 1) {
    throw invalid('maxItems', 'expected an integer of 1 or more');
  }
  return { intervalMs, maxItems };
}

/** A stream's data: bytes of any length (Appendix B rule 6). */
export function checkStreamData(data: unknown): Uint8Array {
  if (!(data instanceof Uint8Array)) {
    throw invalid('data', 'expected a Uint8Array');
  }
  return data;
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
