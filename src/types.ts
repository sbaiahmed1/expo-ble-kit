import type { UUID } from './uuid';

// Public types of plan §5.1 and §5.3. Changing them requires updating the plan, docs and tests
// together (Appendix B, rule 8). The rest of §5 lands with the tasks that use it.

export type BleState =
  'unknown' | 'resetting' | 'unsupported' | 'unauthorized' | 'poweredOff' | 'poweredOn';

export type PermissionStatus = 'granted' | 'denied' | 'undetermined';

/** Removes a JS listener. Synchronous, no I/O, never fails. */
export interface Subscription {
  remove(): void;
}

export interface BlePermissions {
  scan: PermissionStatus;
  connect: PermissionStatus;
  advertise: PermissionStatus;
  /** Android 10–11: ACCESS_BACKGROUND_LOCATION. Elsewhere mirrors `scan`. */
  backgroundScan: PermissionStatus;
  canAskAgain: boolean;
}

/** No flag set means `{ scan: true, connect: true }`. iOS ignores the flags: one prompt covers all. */
export interface BlePermissionRequest {
  scan?: boolean;
  connect?: boolean;
  advertise?: boolean;
  backgroundScan?: boolean;
}

export interface ScanOptions {
  /** Strongly recommended. Required for background scanning on iOS. */
  services?: UUID[];
  allowDuplicates?: boolean; // default false
  /** Batch window for onResults in ms. 0 = deliver immediately (default). */
  reportIntervalMs?: number;
  namePrefix?: string;
  manufacturerData?: { companyId: number; data?: Uint8Array; mask?: Uint8Array }[];
  android?: {
    scanMode?: 'opportunistic' | 'lowPower' | 'balanced' | 'lowLatency'; // default 'balanced'
    callbackType?: 'allMatches' | 'firstMatch' | 'matchLost';
    matchMode?: 'aggressive' | 'sticky';
    legacy?: boolean; // default true
    phy?: 'le1m' | 'leCoded' | 'all';
    reportDelayMs?: number; // hardware batching
  };
  ios?: { solicitedServices?: UUID[] };
}

export interface ScanResult {
  id: string;
  name: string | null;
  rssi: number;
  txPowerLevel: number | null;
  isConnectable: boolean | null;
  serviceUUIDs: UUID[];
  serviceData: Record<UUID, Uint8Array>;
  manufacturerData: Record<number, Uint8Array>; // key = Bluetooth SIG company id
  /** Raw advertising + scan response bytes. Android only; null on iOS. */
  rawAdvertisement: Uint8Array | null;
  timestamp: number;
}

export interface ScanSession {
  readonly active: boolean;
  stop(): void;
}
