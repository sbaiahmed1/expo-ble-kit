import { BleError } from './errors';

/** A Bluetooth UUID. Inputs may be 16-, 32- or 128-bit; outputs are always lowercase 128-bit (§4.12). */
export type UUID = string;

/** The Bluetooth Base UUID suffix: 0000xxxx-0000-1000-8000-00805f9b34fb. */
const BASE_SUFFIX = '-0000-1000-8000-00805f9b34fb';
const SHORT_UUID = /^(?:0x)?([0-9a-f]{4}|[0-9a-f]{8})$/i;
const DASHED_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPACT_UUID = /^[0-9a-f]{32}$/i;

function fromShort(value: number): UUID {
  return `${value.toString(16).padStart(8, '0')}${BASE_SUFFIX}`;
}

function invalid(input: unknown): BleError {
  return new BleError(
    'INVALID_ARGUMENT',
    `Invalid Bluetooth UUID: ${JSON.stringify(input)}. Use a 16-bit ("180d", 0x180d), 32-bit or 128-bit UUID.`
  );
}

/**
 * Normalizes a 16-bit, 32-bit or 128-bit UUID (string or number, any case, with or without dashes)
 * to its lowercase 128-bit form. Throws a BleError with code INVALID_ARGUMENT for anything else.
 *
 * @example normalizeUUID('180D') // '0000180d-0000-1000-8000-00805f9b34fb'
 */
export function normalizeUUID(input: string | number): UUID {
  if (typeof input === 'number') {
    if (!Number.isInteger(input) || input < 0 || input > 0xffffffff) {
      throw invalid(input);
    }
    return fromShort(input);
  }
  if (typeof input !== 'string') {
    throw invalid(input);
  }
  const short = SHORT_UUID.exec(input);
  if (short) {
    return fromShort(parseInt(short[1], 16));
  }
  if (DASHED_UUID.test(input)) {
    return input.toLowerCase();
  }
  if (COMPACT_UUID.test(input)) {
    const hex = input.toLowerCase();
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  throw invalid(input);
}

/** The 128-bit UUID for a 16-bit Bluetooth SIG short UUID. */
export function uuid16(short: number): UUID {
  if (!Number.isInteger(short) || short < 0 || short > 0xffff) {
    throw new BleError(
      'INVALID_ARGUMENT',
      `uuid16 expects an integer from 0 to 0xFFFF, got ${short}`
    );
  }
  return fromShort(short);
}
