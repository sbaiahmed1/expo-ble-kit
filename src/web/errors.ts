import { BleError, BleErrorCode } from '../errors';

/** What a failed Web Bluetooth call was doing, for the codes that depend on it. */
export interface WebErrorContext {
  /** The code when nothing more specific applies. */
  fallback: BleErrorCode;
  /** The code of a `NotSupportedError` ("GATT operation not permitted"). */
  notPermitted?: BleErrorCode;
}

/**
 * Web Bluetooth's DOMExceptions as library errors (plan §4.11). Chrome puts the ATT error in the
 * message ("GATT Error: Not paired."), so the message decides first, then the exception's name.
 */
export function fromWebError(error: unknown, context: WebErrorContext): BleError {
  if (error instanceof BleError) return error;
  const name = (error as { name?: unknown } | null)?.name;
  const text = (error as { message?: unknown } | null)?.message;
  const message = typeof text === 'string' && text ? text : String(error);
  const lower = message.toLowerCase();
  const code = ((): BleErrorCode => {
    if (lower.includes('not paired') || lower.includes('authentication')) {
      return BleErrorCode.INSUFFICIENT_AUTHENTICATION;
    }
    if (lower.includes('encryption')) return BleErrorCode.INSUFFICIENT_ENCRYPTION;
    if (lower.includes('authorization')) return BleErrorCode.INSUFFICIENT_AUTHORIZATION;
    if (lower.includes('attribute length') || name === 'InvalidModificationError') {
      return BleErrorCode.INVALID_ATTRIBUTE_LENGTH;
    }
    switch (name) {
      case 'NetworkError':
      case 'AbortError':
        return context.fallback === BleErrorCode.CONNECTION_FAILED
          ? BleErrorCode.CONNECTION_FAILED
          : BleErrorCode.DISCONNECTED;
      case 'NotSupportedError':
        return context.notPermitted ?? BleErrorCode.NOT_SUPPORTED;
      case 'SecurityError':
      case 'NotAllowedError':
        // Not listed in optionalServices, no user gesture, or blocked by the browser.
        return lower.includes('blocklist')
          ? BleErrorCode.NOT_SUPPORTED
          : BleErrorCode.PERMISSION_DENIED;
      case 'InvalidStateError':
        return BleErrorCode.DISCONNECTED;
      default:
        return context.fallback;
    }
  })();
  return new BleError(
    code,
    `${message} (Web Bluetooth ${typeof name === 'string' ? name : 'error'})`
  );
}

/** Whether `error` is Web Bluetooth's "nothing there" (`NotFoundError`): no services, no descriptors. */
export function isNotFound(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'NotFoundError';
}
