import type { BleErrorCode } from './errors';
import type { BleState, ScanResult } from './types';

export type StateChangeEvent = { state: BleState };
export type ScanResultsEvent = { sessionId: number; results: ScanResult[] };
/** The session has ended. `message` may carry `[blekit]` details for `BleError.fromNative`. */
export type ScanErrorEvent = { sessionId: number; code: BleErrorCode; message: string };
export type WarningEvent = { code: BleErrorCode; message: string };

export type ExpoBleKitModuleEvents = {
  stateChange: (event: StateChangeEvent) => void;
  scanResults: (event: ScanResultsEvent) => void;
  scanError: (event: ScanErrorEvent) => void;
  warning: (event: WarningEvent) => void;
};
