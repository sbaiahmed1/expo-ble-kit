import type { BleErrorCode } from './errors';
import type { BleState, ConnectionState, LogLevel, ScanResult } from './types';

export type StateChangeEvent = { state: BleState };
export type ScanResultsEvent = { sessionId: number; results: ScanResult[] };
/** The session has ended. `message` may carry `[blekit]` details for `BleError.fromNative`. */
export type ScanErrorEvent = { sessionId: number; code: BleErrorCode; message: string };
export type WarningEvent = { code: BleErrorCode; message: string };
/** A native log line (plan §4.16); sent only while JS forwards the log. */
export type LogEvent = {
  level: LogLevel;
  message: string;
  timestamp: number;
  peripheralId?: string | null;
  opId?: number | null;
};

export type ExpoBleKitModuleEvents = {
  stateChange: (event: StateChangeEvent) => void;
  scanResults: (event: ScanResultsEvent) => void;
  scanError: (event: ScanErrorEvent) => void;
  warning: (event: WarningEvent) => void;
  log: (event: LogEvent) => void;
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

/** A batched subscriber's values (P2-04): `bytes` holds them one after another, cut by `lengths`. */
export type NotificationBatchEvent = {
  subscriptionId: number;
  bytes: Uint8Array;
  lengths: number[];
  timestamps: number[];
  dropped: number;
};

/** Bytes a writeStream wrote so far (P2-03), keyed by its operation id. */
export type StreamProgressEvent = { operationId: number | null; sent: number; total: number };

export type PeripheralObjectEvents = {
  connectionStateChange: (event: ConnectionStateEvent) => void;
  notification: (event: NotificationEvent) => void;
  notificationBatch: (event: NotificationBatchEvent) => void;
  mtuChange: (event: MtuChangeEvent) => void;
  subscriptionEnded: (event: SubscriptionEndedEvent) => void;
  streamProgress: (event: StreamProgressEvent) => void;
  /** The services changed and were discovered again (P2-06). */
  servicesChanged: (event: Record<string, never>) => void;
};

/** A central's request to the GATT server (P4-01). Reads carry no value. */
export type ServerRequestEvent = {
  requestId: number;
  centralId: string;
  characteristic: string;
  offset: number;
  value?: Uint8Array | null;
  withResponse?: boolean;
};

export type SubscriptionChangeEvent = {
  centralId: string;
  characteristic: string;
  subscribed: boolean;
};

export type GattServerObjectEvents = {
  readRequest: (event: ServerRequestEvent) => void;
  writeRequest: (event: ServerRequestEvent) => void;
  subscriptionChange: (event: SubscriptionChangeEvent) => void;
};

/** Bytes that arrived on an L2CAP channel (P5-03), once JS started reading. */
export type L2CAPDataEvent = { data: Uint8Array };

/** The channel closed (P5-03); `code` and `message` are set unless either side closed it. */
export type L2CAPCloseEvent = { code?: BleErrorCode | null; message?: string | null };

export type L2CAPChannelObjectEvents = {
  data: (event: L2CAPDataEvent) => void;
  close: (event: L2CAPCloseEvent) => void;
};

/** A central opened a channel; `takeChannel(channelId)` returns it (P5-03). */
export type L2CAPChannelEvent = { channelId: number };

export type L2CAPServerObjectEvents = {
  channel: (event: L2CAPChannelEvent) => void;
};
