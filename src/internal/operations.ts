import { BleError, BleErrorCode, type BleErrorDetails } from '../errors';

// Helpers shared by BleManager and Peripheral: error conversion with the diagnostics ring buffer
// (plan §5.7), and AbortSignal wiring (plan §4.9).

const RECENT_ERRORS = 100;
const recent: BleError[] = [];

/** Keeps `error` among the last 100 for `getDiagnostics()`, and returns it. */
export function recordError(error: BleError): BleError {
  recent.push(error);
  if (recent.length > RECENT_ERRORS) {
    recent.shift();
  }
  return error;
}

export function recentErrors(): BleError[] {
  return [...recent];
}

type ErrorContext = Pick<BleErrorDetails, 'peripheralId' | 'serviceUUID' | 'characteristicUUID'>;

/** `error` with the context fields it lacks; the same object when it lacks none. */
function withContext(error: BleError, context: ErrorContext): BleError {
  const missing = (Object.keys(context) as (keyof ErrorContext)[]).filter(
    (key) => context[key] !== undefined && error[key] === undefined
  );
  if (missing.length === 0) {
    return error;
  }
  const merged = new BleError(error.code, error.message, {
    retryable: error.retryable,
    peripheralId: error.peripheralId ?? context.peripheralId,
    serviceUUID: error.serviceUUID ?? context.serviceUUID,
    characteristicUUID: error.characteristicUUID ?? context.characteristicUUID,
    nativeDomain: error.nativeDomain,
    nativeCode: error.nativeCode,
    gattStatus: error.gattStatus,
    cause: error.cause,
  });
  merged.stack = error.stack;
  return merged;
}

/** Converts anything a call threw into a recorded BleError that names what it was about. */
export function toBleError(error: unknown, context: ErrorContext = {}): BleError {
  if (error instanceof BleError) {
    const contextual = withContext(error, context);
    return recent.includes(contextual) ? contextual : recordError(contextual);
  }
  return recordError(BleError.fromNative(error, context));
}

/** Runs `work`, turning a throw or a rejection into a recorded BleError. */
export async function guard<T>(work: () => Promise<T> | T, context: ErrorContext = {}): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toBleError(error, context);
  }
}

/** Validates `OpOptions.signal`: anything with `aborted` and `addEventListener`. */
export function checkSignal(signal: unknown): AbortSignal | undefined {
  if (signal === undefined) {
    return undefined;
  }
  const candidate = signal as Partial<AbortSignal> | null;
  if (
    typeof candidate?.aborted !== 'boolean' ||
    typeof candidate.addEventListener !== 'function' ||
    typeof candidate.removeEventListener !== 'function'
  ) {
    throw new BleError(BleErrorCode.INVALID_ARGUMENT, 'Invalid signal: expected an AbortSignal');
  }
  return signal as AbortSignal;
}

export function abortedError(): BleError {
  return new BleError(BleErrorCode.OPERATION_CANCELLED, 'The operation was aborted');
}

/** Native operation ids fit a 32-bit integer. */
const MAX_OPERATION_ID = 0x7fffffff;
let nextOperationId = 1;

/**
 * Runs a native operation that `signal` can cancel (plan §4.9). Without a signal the operation gets
 * no id. An already aborted signal rejects with OPERATION_CANCELLED and starts nothing; a later
 * abort calls `cancel`, after which the native side rejects with OPERATION_CANCELLED.
 */
export async function cancellable<T>(
  signal: AbortSignal | undefined,
  start: (operationId: number | null) => Promise<T>,
  cancel: (operationId: number) => void
): Promise<T> {
  if (!signal) {
    return start(null);
  }
  if (signal.aborted) {
    throw abortedError();
  }
  const operationId = nextOperationId;
  nextOperationId = nextOperationId === MAX_OPERATION_ID ? 1 : nextOperationId + 1;
  const onAbort = () => cancel(operationId);
  signal.addEventListener('abort', onAbort);
  try {
    return await start(operationId);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Reports an error thrown by app code (a listener) without stopping the others. */
export function reportListenerError(error: unknown): void {
  setTimeout(() => {
    throw error;
  }, 0);
}
