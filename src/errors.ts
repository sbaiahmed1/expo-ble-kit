import { Platform } from 'react-native';

/**
 * The code of every {@link BleError}. Compare `error.code` with these values. The meaning of an
 * existing code never changes.
 */
// Plan §4.11, §9. The native cores use the same strings: ios/Core/CoreError.swift and
// android/.../core/CoreError.kt.
export const BleErrorCode = {
  /** The device has no Bluetooth LE. */
  BLUETOOTH_UNSUPPORTED: 'BLUETOOTH_UNSUPPORTED',
  /** The app may not use Bluetooth: permission denied or restricted (iOS), or not requested yet. */
  BLUETOOTH_UNAUTHORIZED: 'BLUETOOTH_UNAUTHORIZED',
  /** Bluetooth is off. The user has to turn it on. */
  BLUETOOTH_POWERED_OFF: 'BLUETOOTH_POWERED_OFF',
  /** Bluetooth is turning on or off, or restarting. Retry shortly. */
  BLUETOOTH_RESETTING: 'BLUETOOTH_RESETTING',
  /** A specific runtime permission is missing (Android). The message names it. */
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /** A required Info.plist key or manifest permission is missing. The message names it and links the setup guide. */
  MISCONFIGURED: 'MISCONFIGURED',
  /** Input rejected by validation: a malformed UUID, an out-of-range value, conflicting options. */
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  /** The scanner reported an error (Android scan failure codes). */
  SCAN_FAILED: 'SCAN_FAILED',
  /** Android allows 5 scan starts per 30 s; the scan starts later. Sent as a warning. */
  SCAN_THROTTLED: 'SCAN_THROTTLED',
  /** iOS doesn't know this id. Scan for the device first. */
  PERIPHERAL_NOT_FOUND: 'PERIPHERAL_NOT_FOUND',
  /** The link could not be established (includes Android status 133). Retryable. */
  CONNECTION_FAILED: 'CONNECTION_FAILED',
  /** The connect timeout fired. Retryable. */
  CONNECTION_TIMEOUT: 'CONNECTION_TIMEOUT',
  /** Not connected, or the link was lost while an operation was pending. */
  DISCONNECTED: 'DISCONNECTED',
  /** An operation took longer than its timeout. Retryable. */
  OPERATION_TIMEOUT: 'OPERATION_TIMEOUT',
  /** Cancelled by an `AbortSignal` or by `disconnect()`. */
  OPERATION_CANCELLED: 'OPERATION_CANCELLED',
  /** The service isn't in the discovery cache: discover it first. */
  SERVICE_NOT_FOUND: 'SERVICE_NOT_FOUND',
  /** The characteristic isn't in the discovery cache. */
  CHARACTERISTIC_NOT_FOUND: 'CHARACTERISTIC_NOT_FOUND',
  /** The descriptor isn't in the discovery cache. */
  DESCRIPTOR_NOT_FOUND: 'DESCRIPTOR_NOT_FOUND',
  /** The characteristic, the platform or this version doesn't support the operation. */
  NOT_SUPPORTED: 'NOT_SUPPORTED',
  /** The characteristic or descriptor can't be read. */
  READ_NOT_PERMITTED: 'READ_NOT_PERMITTED',
  /** The characteristic or descriptor can't be written (this way). */
  WRITE_NOT_PERMITTED: 'WRITE_NOT_PERMITTED',
  /** The attribute needs an authenticated (bonded) link. */
  INSUFFICIENT_AUTHENTICATION: 'INSUFFICIENT_AUTHENTICATION',
  /** The attribute needs an encrypted link. */
  INSUFFICIENT_ENCRYPTION: 'INSUFFICIENT_ENCRYPTION',
  /** The peripheral refused: authorization needed. */
  INSUFFICIENT_AUTHORIZATION: 'INSUFFICIENT_AUTHORIZATION',
  /** The value is too long: 512 bytes at most, one packet without response. */
  INVALID_ATTRIBUTE_LENGTH: 'INVALID_ATTRIBUTE_LENGTH',
  /** The peripheral rejected the offset of a long read or write. */
  INVALID_OFFSET: 'INVALID_OFFSET',
  /** The Android connection is congested. Retry with a backoff. */
  CONGESTED: 'CONGESTED',
  /**
   * Values arrived faster than a batched subscription delivers them, and the oldest were dropped
   * (counted in `NotificationBatch.dropped`). Sent as a warning.
   */
  BUFFER_OVERFLOW: 'BUFFER_OVERFLOW',
  /** Any other ATT or GATT status; see `gattStatus`. */
  GATT_ERROR: 'GATT_ERROR',
  /** Bonding failed or was rejected. */
  BOND_FAILED: 'BOND_FAILED',
  /** The advertiser reported an error. */
  ADVERTISING_FAILED: 'ADVERTISING_FAILED',
  /**
   * Android refused to start the foreground service of `keepAliveInBackground` (the app was in the
   * background). The connection goes on without it. Sent as a warning.
   */
  FOREGROUND_SERVICE_FAILED: 'FOREGROUND_SERVICE_FAILED',
  /** An L2CAP channel failed to open, or an I/O error. */
  L2CAP_FAILED: 'L2CAP_FAILED',
  /** A bug. Include `getDiagnostics()` output in reports. */
  INTERNAL: 'INTERNAL',
} as const;

// The value and the type share one name on purpose, so callers import a single `BleErrorCode`.
// eslint-disable-next-line @typescript-eslint/no-redeclare
export type BleErrorCode = (typeof BleErrorCode)[keyof typeof BleErrorCode];

/** Codes that are worth retrying by default. Codes marked "depends" in §4.11 are set per error. */
const RETRYABLE_BY_DEFAULT: ReadonlySet<BleErrorCode> = new Set<BleErrorCode>([
  'BLUETOOTH_RESETTING',
  'SCAN_THROTTLED',
  'CONNECTION_FAILED',
  'CONNECTION_TIMEOUT',
  'OPERATION_TIMEOUT',
  'CONGESTED',
]);

const CODES: ReadonlySet<string> = new Set(Object.values(BleErrorCode));

/** The optional fields of a {@link BleError}, for its constructor. */
export interface BleErrorDetails {
  /** Overrides the default for the code. */
  retryable?: boolean;
  /** The peripheral the error is about. */
  peripheralId?: string;
  /** The service the error is about. */
  serviceUUID?: string;
  /** The characteristic the error is about. */
  characteristicUUID?: string;
  /** e.g. `CBErrorDomain`, `CBATTErrorDomain`, `android.bluetooth`. */
  nativeDomain?: string;
  /** The platform's own error code. */
  nativeCode?: number;
  /** Android GATT or HCI status, when relevant. */
  gattStatus?: number;
  /** The underlying error. */
  cause?: unknown;
}

/**
 * Internal contract with the binding: native rejections carry `code` (a BleErrorCode) and may embed
 * extra fields in the message as `[blekit]{...json...}` (flat JSON). `fromNative` strips it.
 */
const NATIVE_DETAILS = /\s*\[blekit\](\{[^{}]*\})/;

/**
 * Every error expo-ble-kit rejects or throws. Check `code` (a {@link BleErrorCode}) rather than the
 * message, which may change.
 */
export class BleError extends Error {
  /** What went wrong. */
  readonly code: BleErrorCode;
  /** Whether retrying the same call can succeed without user action. */
  readonly retryable: boolean;
  /** The platform the error came from. */
  readonly platform: 'ios' | 'android' | 'web';
  /** The peripheral the error is about. */
  readonly peripheralId?: string;
  /** The service the error is about. */
  readonly serviceUUID?: string;
  /** The characteristic the error is about. */
  readonly characteristicUUID?: string;
  /** e.g. `CBErrorDomain`, `CBATTErrorDomain`, `android.bluetooth`. */
  readonly nativeDomain?: string;
  /** The platform's own error code. */
  readonly nativeCode?: number;
  /** Android GATT or HCI status, when relevant. */
  readonly gattStatus?: number;
  /** The underlying error. */
  readonly cause?: unknown;

  constructor(code: BleErrorCode, message: string, details: BleErrorDetails = {}) {
    super(message);
    // Keeps `instanceof BleError` working when classes are compiled to ES5.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'BleError';
    this.code = code;
    this.retryable = details.retryable ?? RETRYABLE_BY_DEFAULT.has(code);
    this.platform = Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web';
    this.peripheralId = details.peripheralId;
    this.serviceUUID = details.serviceUUID;
    this.characteristicUUID = details.characteristicUUID;
    this.nativeDomain = details.nativeDomain;
    this.nativeCode = details.nativeCode;
    this.gattStatus = details.gattStatus;
    this.cause = details.cause;
  }

  /** Whether `value` is one of the {@link BleErrorCode} values. */
  static isBleErrorCode(value: unknown): value is BleErrorCode {
    return typeof value === 'string' && CODES.has(value);
  }

  /** Converts anything thrown by the native module into a BleError. Unknown errors become INTERNAL. */
  static fromNative(error: unknown, context: Omit<BleErrorDetails, 'cause'> = {}): BleError {
    if (error instanceof BleError) {
      return error;
    }
    const raw = error as { code?: unknown; message?: unknown } | null | undefined;
    const rawMessage = typeof raw?.message === 'string' ? raw.message : String(error);
    const match = NATIVE_DETAILS.exec(rawMessage);
    const message = match ? rawMessage.replace(NATIVE_DETAILS, '').trim() : rawMessage;
    const nativeDetails = match ? parseDetails(match[1]) : {};
    const code = BleError.isBleErrorCode(raw?.code) ? raw.code : BleErrorCode.INTERNAL;
    return new BleError(code, message, { ...context, ...nativeDetails, cause: error });
  }
}

function parseDetails(json: string): BleErrorDetails {
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    const details: BleErrorDetails = {};
    if (typeof value.retryable === 'boolean') details.retryable = value.retryable;
    if (typeof value.nativeDomain === 'string') details.nativeDomain = value.nativeDomain;
    if (typeof value.nativeCode === 'number') details.nativeCode = value.nativeCode;
    if (typeof value.gattStatus === 'number') details.gattStatus = value.gattStatus;
    if (typeof value.peripheralId === 'string') details.peripheralId = value.peripheralId;
    if (typeof value.serviceUUID === 'string') details.serviceUUID = value.serviceUUID;
    if (typeof value.characteristicUUID === 'string')
      details.characteristicUUID = value.characteristicUUID;
    return details;
  } catch {
    return {};
  }
}
