import { Platform } from 'react-native';

import { BleError } from '../errors';
import type { BackgroundTaskOptions, BleBackgroundEvent } from '../types';
import type { UUID } from '../uuid';
import { toNativeScanOptions } from './scanOptions';

/**
 * What the native `registerBackgroundTask` takes (P3-04). TaskManager persists it as JSON, so
 * manufacturer data bytes travel as number arrays. Absent values are left out: Expo's map
 * conversion rejects nulls nested in it.
 */
export interface NativeBackgroundTaskOptions {
  events: BleBackgroundEvent['type'][];
  scan: {
    services: UUID[];
    namePrefix?: string;
    manufacturerData: { companyId: number; data?: number[]; mask?: number[] }[];
  };
}

const EVENTS: BleBackgroundEvent['type'][] = [
  'restored',
  'scanResults',
  'connectionStateChange',
  'notification',
  'devicePresence',
];
/** Events Android delivers so far; the others come with later tasks (plan §7: P3-02, P5-05). */
const SUPPORTED: BleBackgroundEvent['type'][] = ['scanResults'];

function invalid(option: string, problem: string): BleError {
  return new BleError('INVALID_ARGUMENT', `Invalid background task ${option}: ${problem}`);
}

export function checkTaskName(taskName: unknown): string {
  if (typeof taskName !== 'string' || taskName.trim() === '') {
    throw invalid('name', 'expected a non-empty string');
  }
  return taskName;
}

/**
 * Validates `registerBackgroundTask` options (plan §5.6). Throws INVALID_ARGUMENT, or
 * NOT_SUPPORTED on iOS and for events a later task delivers.
 */
export function toNativeBackgroundTaskOptions(
  options: BackgroundTaskOptions
): NativeBackgroundTaskOptions {
  if (typeof options !== 'object' || options === null) {
    throw invalid('options', 'expected an object');
  }
  const { events, scan } = options;
  if (!Array.isArray(events) || events.length === 0) {
    throw invalid('events', `expected a non-empty array of ${EVENTS.join(', ')}`);
  }
  for (const event of events) {
    if (!EVENTS.includes(event)) {
      throw invalid('events', `unknown event ${String(event)}; expected ${EVENTS.join(', ')}`);
    }
  }
  if (Platform.OS !== 'android') {
    throw new BleError(
      'NOT_SUPPORTED',
      "registerBackgroundTask isn't supported on iOS yet: it comes with background events"
    );
  }
  const later = events.filter((event) => !SUPPORTED.includes(event));
  if (later.length > 0) {
    throw new BleError(
      'NOT_SUPPORTED',
      `Background events ${later.join(', ')} aren't supported yet; supported: ${SUPPORTED.join(', ')}`
    );
  }
  if (scan === undefined) {
    throw invalid('scan', 'required with the scanResults event');
  }
  const { services, manufacturerData, namePrefix } = toNativeScanOptions(scan);
  if (services.length === 0 && manufacturerData.length === 0) {
    throw invalid(
      'scan',
      'needs services or manufacturerData: a background scan is filtered by the Bluetooth controller'
    );
  }
  return {
    events: [...new Set(events)],
    scan: {
      services,
      ...(namePrefix !== undefined && { namePrefix }),
      manufacturerData: manufacturerData.map(({ companyId, data, mask }) => ({
        companyId,
        ...(data && { data: Array.from(data) }),
        ...(mask && { mask: Array.from(mask) }),
      })),
    },
  };
}
