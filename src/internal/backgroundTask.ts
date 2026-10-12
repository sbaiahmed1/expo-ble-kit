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
  /** With `scanResults` (Android). */
  scan?: {
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
/** Events each platform delivers (plan §7: P3-04 Android scans, P5-05 presence, P3-02 iOS restoration). */
const SUPPORTED: Partial<Record<typeof Platform.OS, BleBackgroundEvent['type'][]>> = {
  android: ['scanResults', 'devicePresence'],
  ios: ['restored', 'connectionStateChange', 'notification'],
};

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
 * NOT_SUPPORTED for events the platform doesn't deliver.
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
  const supported = SUPPORTED[Platform.OS] ?? [];
  const unsupported = events.filter((event) => !supported.includes(event));
  if (unsupported.length > 0) {
    throw new BleError(
      'NOT_SUPPORTED',
      `Background events ${unsupported.join(', ')} aren't supported on ${Platform.OS}; ` +
        `supported: ${supported.join(', ') || 'none'}`
    );
  }
  if (!events.includes('scanResults')) {
    return { events: [...new Set(events)] };
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
