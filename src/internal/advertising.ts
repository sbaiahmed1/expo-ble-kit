import { BleError } from '../errors';
import type { AdvertisingData, AdvertisingOptions } from '../types';
import { normalizeUUID, type UUID } from '../uuid';

/** What the native `startAdvertising` takes: validated, defaults applied, UUIDs normalized. */
export interface NativeAdvertisingData {
  localName?: string;
  serviceUuids: UUID[];
  manufacturerData?: { companyId: number; data: Uint8Array };
  serviceData: { uuid: UUID; data: Uint8Array }[];
  includeTxPower: boolean;
}

export interface NativeAdvertisingOptions {
  connectable: boolean;
  mode: 'lowPower' | 'balanced' | 'lowLatency';
  txPower: 'ultraLow' | 'low' | 'medium' | 'high';
  extended: boolean;
  /** Absent: no timeout. */
  timeoutMs?: number;
}

const MODES = ['lowPower', 'balanced', 'lowLatency'] as const;
const TX_POWERS = ['ultraLow', 'low', 'medium', 'high'] as const;
/** Android's advertising duration is in 10 ms units, at most 65,535. */
const MAX_TIMEOUT_MS = 655_350;

function invalid(option: string, problem: string): BleError {
  return new BleError('INVALID_ARGUMENT', `Invalid advertising ${option}: ${problem}`);
}

function object(option: string, value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(option, 'expected an object');
  }
  return value as Record<string, unknown>;
}

function boolean(option: string, value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw invalid(option, 'expected a boolean');
  return value;
}

function oneOf<T extends string>(
  option: string,
  value: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw invalid(option, `expected one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function bytes(option: string, value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw invalid(option, 'expected a Uint8Array');
  return value;
}

function uuid(option: string, value: unknown): UUID {
  try {
    return normalizeUUID(value as string);
  } catch {
    throw invalid(option, 'expected a UUID');
  }
}

/** Validates `startAdvertising`'s arguments for both platforms (plan §5.5). */
export function toNativeAdvertising(
  data: AdvertisingData,
  options: AdvertisingOptions | undefined
): { data: NativeAdvertisingData; options: NativeAdvertisingOptions } {
  const fields = object('data', data);
  const { localName, serviceUUIDs, manufacturerData, serviceData, includeTxPower } = fields;
  if (localName !== undefined && (typeof localName !== 'string' || localName.length === 0)) {
    throw invalid('localName', 'expected a non-empty string');
  }
  if (serviceUUIDs !== undefined && !Array.isArray(serviceUUIDs)) {
    throw invalid('serviceUUIDs', 'expected an array of UUIDs');
  }
  const serviceUuids = [
    ...new Set((serviceUUIDs ?? []).map((value, i) => uuid(`serviceUUIDs[${i}]`, value))),
  ];
  let manufacturer: NativeAdvertisingData['manufacturerData'];
  if (manufacturerData !== undefined) {
    const { companyId, data: payload } = object('manufacturerData', manufacturerData);
    if (
      typeof companyId !== 'number' ||
      !Number.isInteger(companyId) ||
      companyId < 0 ||
      companyId > 0xffff
    ) {
      throw invalid('manufacturerData.companyId', 'expected an integer from 0 to 0xFFFF');
    }
    manufacturer = { companyId, data: bytes('manufacturerData.data', payload) };
  }
  const entries =
    serviceData === undefined ? [] : Object.entries(object('serviceData', serviceData));
  const native: NativeAdvertisingData = {
    serviceUuids,
    serviceData: entries.map(([key, value]) => ({
      uuid: uuid(`serviceData key ${key}`, key),
      data: bytes(`serviceData[${key}]`, value),
    })),
    includeTxPower: boolean('includeTxPower', includeTxPower, false),
  };
  if (localName !== undefined) native.localName = localName as string;
  if (manufacturer) native.manufacturerData = manufacturer;

  const settings = options === undefined ? {} : object('options', options);
  const android = settings.android === undefined ? {} : object('options.android', settings.android);
  const timeoutMs = android.timeoutMs;
  const nativeOptions: NativeAdvertisingOptions = {
    connectable: boolean('options.connectable', settings.connectable, true),
    mode: oneOf('options.android.mode', android.mode, MODES, 'lowLatency'),
    txPower: oneOf('options.android.txPower', android.txPower, TX_POWERS, 'medium'),
    extended: boolean('options.android.extended', android.extended, false),
  };
  if (timeoutMs !== undefined) {
    if (
      typeof timeoutMs !== 'number' ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs < 10 ||
      timeoutMs > MAX_TIMEOUT_MS
    ) {
      throw invalid(
        'options.android.timeoutMs',
        `expected milliseconds from 10 to ${MAX_TIMEOUT_MS}`
      );
    }
    nativeOptions.timeoutMs = Math.round(timeoutMs);
  }
  return { data: native, options: nativeOptions };
}
