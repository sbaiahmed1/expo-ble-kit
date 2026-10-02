import { Platform } from 'react-native';

/**
 * Error codes (plan §4.11). The meaning of an existing code never changes (plan §9).
 * The native cores use the same strings: ios/Core/CoreError.swift and android/.../core/CoreError.kt.
 */
export const BleErrorCode = {
  BLUETOOTH_UNSUPPORTED: 'BLUETOOTH_UNSUPPORTED',
  BLUETOOTH_UNAUTHORIZED: 'BLUETOOTH_UNAUTHORIZED',
  BLUETOOTH_POWERED_OFF: 'BLUETOOTH_POWERED_OFF',
  BLUETOOTH_RESETTING: 'BLUETOOTH_RESETTING',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  MISCONFIGURED: 'MISCONFIGURED',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  SCAN_FAILED: 'SCAN_FAILED',
  SCAN_THROTTLED: 'SCAN_THROTTLED',
  PERIPHERAL_NOT_FOUND: 'PERIPHERAL_NOT_FOUND',
  CONNECTION_FAILED: 'CONNECTION_FAILED',
  CONNECTION_TIMEOUT: 'CONNECTION_TIMEOUT',
  DISCONNECTED: 'DISCONNECTED',
  OPERATION_TIMEOUT: 'OPERATION_TIMEOUT',
  OPERATION_CANCELLED: 'OPERATION_CANCELLED',
  SERVICE_NOT_FOUND: 'SERVICE_NOT_FOUND',
  CHARACTERISTIC_NOT_FOUND: 'CHARACTERISTIC_NOT_FOUND',
  DESCRIPTOR_NOT_FOUND: 'DESCRIPTOR_NOT_FOUND',
  NOT_SUPPORTED: 'NOT_SUPPORTED',
  READ_NOT_PERMITTED: 'READ_NOT_PERMITTED',
  WRITE_NOT_PERMITTED: 'WRITE_NOT_PERMITTED',
  INSUFFICIENT_AUTHENTICATION: 'INSUFFICIENT_AUTHENTICATION',
  INSUFFICIENT_ENCRYPTION: 'INSUFFICIENT_ENCRYPTION',
  INSUFFICIENT_AUTHORIZATION: 'INSUFFICIENT_AUTHORIZATION',
  INVALID_ATTRIBUTE_LENGTH: 'INVALID_ATTRIBUTE_LENGTH',
  INVALID_OFFSET: 'INVALID_OFFSET',
  CONGESTED: 'CONGESTED',
  GATT_ERROR: 'GATT_ERROR',
  BOND_FAILED: 'BOND_FAILED',
  ADVERTISING_FAILED: 'ADVERTISING_FAILED',
  L2CAP_FAILED: 'L2CAP_FAILED',
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

export interface BleErrorDetails {
  retryable?: boolean;
  peripheralId?: string;
  serviceUUID?: string;
  characteristicUUID?: string;
  /** e.g. `CBErrorDomain`, `CBATTErrorDomain`, `android.bluetooth`. */
  nativeDomain?: string;
  nativeCode?: number;
  /** Android GATT or HCI status, when relevant. */
  gattStatus?: number;
  cause?: unknown;
}

/**
 * Internal contract with the binding: native rejections carry `code` (a BleErrorCode) and may embed
 * extra fields in the message as `[blekit]{...json...}` (flat JSON). `fromNative` strips it.
 */
const NATIVE_DETAILS = /\s*\[blekit\](\{[^{}]*\})/;

export class BleError extends Error {
  readonly code: BleErrorCode;
  /** Whether retrying the same call can succeed without user action. */
  readonly retryable: boolean;
  readonly platform: 'ios' | 'android' | 'web';
  readonly peripheralId?: string;
  readonly serviceUUID?: string;
  readonly characteristicUUID?: string;
  readonly nativeDomain?: string;
  readonly nativeCode?: number;
  readonly gattStatus?: number;
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
