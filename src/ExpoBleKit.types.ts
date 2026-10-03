import type { BleErrorCode } from './errors';
import type { BleState, ConnectionState, ScanResult } from './types';

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

/** `code` and `message` are set when the connection ended or failed unexpectedly. */
export type ConnectionStateEvent = {
  state: ConnectionState;
  code?: BleErrorCode;
  message?: string;
};

/** One notification or indication; `timestamp` in epoch milliseconds (plan §4.10). */
export type NotificationEvent = {
  service: string;
  characteristic: string;
  value: Uint8Array;
  timestamp: number;
};

/** The ATT MTU of a ready connection changed (Android; iOS when a refresh sees a new value). */
export type MtuChangeEvent = { mtu: number };

/** A subscription ended while its connection reconnects (P2-01): not restored, or restore failed. */
export type SubscriptionEndedEvent = {
  subscriptionId: number;
  code: BleErrorCode;
  message: string;
};

/** Bytes a writeStream wrote so far (P2-03), keyed by its operation id. */
export type StreamProgressEvent = { operationId: number | null; sent: number; total: number };

export type PeripheralObjectEvents = {
  connectionStateChange: (event: ConnectionStateEvent) => void;
  notification: (event: NotificationEvent) => void;
  mtuChange: (event: MtuChangeEvent) => void;
  subscriptionEnded: (event: SubscriptionEndedEvent) => void;
  streamProgress: (event: StreamProgressEvent) => void;
};
