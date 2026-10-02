import { BleError } from '../errors';
import type { ScanOptions } from '../types';
import { normalizeUUID, type UUID } from '../uuid';

/** What the native `startScan` takes: validated, defaults applied, UUIDs normalized. */
export interface NativeScanOptions {
  services: UUID[];
  allowDuplicates: boolean;
  reportIntervalMs: number;
  namePrefix?: string;
  manufacturerData: { companyId: number; data?: Uint8Array; mask?: Uint8Array }[];
  android: {
    scanMode?: string;
    callbackType?: string;
    matchMode?: string;
    legacy: boolean;
    phy?: string;
    reportDelayMs: number;
  };
  ios: { solicitedServices: UUID[] };
}

const SCAN_MODES = ['opportunistic', 'lowPower', 'balanced', 'lowLatency'];
const CALLBACK_TYPES = ['allMatches', 'firstMatch', 'matchLost'];
const MATCH_MODES = ['aggressive', 'sticky'];
const PHYS = ['le1m', 'leCoded', 'all'];

function invalid(option: string, problem: string): BleError {
  return new BleError('INVALID_ARGUMENT', `Invalid scan option ${option}: ${problem}`);
}

function milliseconds(option: string, value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw invalid(option, 'expected a number of milliseconds, 0 or more');
  }
  return Math.round(value);
}

function oneOf(option: string, value: unknown, allowed: string[]): string | undefined {
  if (value !== undefined && (typeof value !== 'string' || !allowed.includes(value))) {
    throw invalid(option, `expected one of ${allowed.join(', ')}`);
  }
  return value;
}

function uuids(option: string, value: unknown): UUID[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw invalid(option, 'expected an array of UUIDs');
  }
  return [...new Set(value.map((uuid) => normalizeUUID(uuid)))];
}

function bytes(option: string, value: unknown): Uint8Array | undefined {
  if (value !== undefined && !(value instanceof Uint8Array)) {
    throw invalid(option, 'expected a Uint8Array');
  }
  return value;
}

/** Validates JS `ScanOptions` (plan §5.3). Throws a BleError with code INVALID_ARGUMENT. */
export function toNativeScanOptions(options: ScanOptions = {}): NativeScanOptions {
  if (typeof options !== 'object' || options === null) {
    throw invalid('options', 'expected an object');
  }
  if (options.allowDuplicates !== undefined && typeof options.allowDuplicates !== 'boolean') {
    throw invalid('allowDuplicates', 'expected a boolean');
  }
  if (options.namePrefix !== undefined && typeof options.namePrefix !== 'string') {
    throw invalid('namePrefix', 'expected a string');
  }
  const manufacturerData = (options.manufacturerData ?? []).map((filter, index) => {
    const option = `manufacturerData[${index}]`;
    const { companyId } = filter ?? {};
    if (
      typeof companyId !== 'number' ||
      !Number.isInteger(companyId) ||
      companyId < 0 ||
      companyId > 0xffff
    ) {
      throw invalid(`${option}.companyId`, 'expected an integer from 0 to 0xFFFF');
    }
    const data = bytes(`${option}.data`, filter.data);
    const mask = bytes(`${option}.mask`, filter.mask);
    if (mask && (!data || mask.length !== data.length)) {
      throw invalid(`${option}.mask`, 'needs data of the same length');
    }
    return { companyId, ...(data && { data }), ...(mask && { mask }) };
  });
  const android = options.android ?? {};
  if (android.legacy !== undefined && typeof android.legacy !== 'boolean') {
    throw invalid('android.legacy', 'expected a boolean');
  }
  return {
    services: uuids('services', options.services),
    allowDuplicates: options.allowDuplicates ?? false,
    reportIntervalMs: milliseconds('reportIntervalMs', options.reportIntervalMs),
    ...(options.namePrefix !== undefined && { namePrefix: options.namePrefix }),
    manufacturerData,
    android: {
      scanMode: oneOf('android.scanMode', android.scanMode, SCAN_MODES),
      callbackType: oneOf('android.callbackType', android.callbackType, CALLBACK_TYPES),
      matchMode: oneOf('android.matchMode', android.matchMode, MATCH_MODES),
      legacy: android.legacy ?? true,
      phy: oneOf('android.phy', android.phy, PHYS),
      reportDelayMs: milliseconds('android.reportDelayMs', android.reportDelayMs),
    },
    ios: { solicitedServices: uuids('ios.solicitedServices', options.ios?.solicitedServices) },
  };
}
