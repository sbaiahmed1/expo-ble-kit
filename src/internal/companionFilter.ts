import { BleError, BleErrorCode } from '../errors';
import type { CompanionDeviceFilter } from '../types';
import { normalizeUUID } from '../uuid';

/** What the native `associateCompanionDevice` takes (P5-05), in its argument order. */
export type NativeCompanionFilter = [
  services: string[],
  namePattern: string | null,
  singleDevice: boolean,
];

function invalid(problem: string): BleError {
  return new BleError(BleErrorCode.INVALID_ARGUMENT, `Invalid companion device filter: ${problem}`);
}

/**
 * Validates a `CompanionDeviceFilter`. The name pattern is a Java regular expression; JS checks it
 * as its own syntax, which catches most mistakes, and Android compiles it again.
 */
export function toNativeCompanionFilter(filter: CompanionDeviceFilter): NativeCompanionFilter {
  if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
    throw invalid('expected an object');
  }
  const { services, namePattern, singleDevice } = filter;
  if (services !== undefined && !Array.isArray(services)) {
    throw invalid('services must be an array of UUIDs');
  }
  const uuids = [...new Set((services ?? []).map((service) => normalizeUUID(service)))];
  if (namePattern !== undefined) {
    if (typeof namePattern !== 'string' || namePattern === '') {
      throw invalid('namePattern must be a non-empty string');
    }
    try {
      RegExp(namePattern);
    } catch {
      throw invalid(`namePattern ${namePattern} isn't a regular expression`);
    }
  }
  if (singleDevice !== undefined && typeof singleDevice !== 'boolean') {
    throw invalid('singleDevice must be a boolean');
  }
  return [uuids, namePattern ?? null, singleDevice ?? false];
}
