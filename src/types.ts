// Public types of plan §5.1. Changing them requires updating the plan, docs and tests together
// (Appendix B, rule 8). The rest of §5.1 lands with the tasks that use it.

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
