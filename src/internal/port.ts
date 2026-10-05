import type {
  ConnectionStateEvent,
  ExpoBleKitModuleEvents,
  GattServerObjectEvents,
  MtuChangeEvent,
  NotificationEvent,
  PeripheralObjectEvents,
} from '../ExpoBleKit.types';
import type {
  BlePermissionRequest,
  BlePermissions,
  BleState,
  ConnectionState,
  Diagnostics,
  ForegroundServiceNotification,
  LogLevel,
  Service,
  Subscription,
} from '../types';
import type { NativeAttributeRequest, NativeSubscribeMode } from './attributeRequest';
import type { NativeBackgroundTaskOptions } from './backgroundTask';
import type { NativeConnectOptions } from './connectOptions';
import type { NativeServiceDefinition } from './gattServer';
import type { NativeScanOptions } from './scanOptions';

/**
 * What the TS layer needs from the native side (plan §4.6). The native module implements it, and so
 * does `FakeBleAdapter` for tests. Native binding tasks extend it as they land.
 *
 * Inputs are already validated and normalized by the TS layer (`src/internal/*Options.ts`,
 * `attributeRequest.ts`); rejections carry a BleErrorCode `code` for `BleError.fromNative`.
 */
export interface NativeBleKitPort {
  getState(): BleState;
  getPermissionsAsync(): Promise<BlePermissions>;
  requestPermissionsAsync(request?: BlePermissionRequest): Promise<BlePermissions>;
  /** Results and the session's end arrive as `scanResults` and `scanError` events. */
  startScan(sessionId: number, options: NativeScanOptions): Promise<void>;
  stopScan(sessionId: number): Promise<void>;
  /** No I/O; never creates a manager (plan §5.2). The same object for the same id. */
  getPeripheral(id: string): NativePeripheralPort;
  /** The ids the system knows: iOS drops unknown ones, Android keeps every valid address. */
  getKnownPeripherals(ids: string[]): Promise<string[]>;
  /** Ids of peripherals connected at the OS level. Android can't filter by `services` (plan §6). */
  getSystemConnectedPeripherals(services: string[]): Promise<string[]>;
  /** State, sessions and, on Android, open GATT clients; JS adds permissions and errors. */
  getDiagnosticsAsync(): Promise<NativeDiagnostics>;
  /** The native log level (plan §4.16). */
  setLogLevel(level: LogLevel): void;
  /** While on, native log lines also arrive as `log` events. */
  setLogForwarding(enabled: boolean): void;
  /** The GATT server (P4-01): one at a time; resolves once every service is published. */
  openGattServer(services: NativeServiceDefinition[]): Promise<NativeGattServerPort>;
  /** Android only (P3-04): a TaskManager task with a background scan. */
  registerBackgroundTask?(taskName: string, options: NativeBackgroundTaskOptions): Promise<void>;
  unregisterBackgroundTask?(taskName: string): Promise<void>;
  /** Android only (P3-03): the keep-alive notification, validated. */
  setForegroundServiceNotification?(notification: ForegroundServiceNotification): void;
  addListener<E extends keyof ExpoBleKitModuleEvents>(
    event: E,
    listener: ExpoBleKitModuleEvents[E]
  ): Subscription;
}

export type NativeDiagnostics = Pick<Diagnostics, 'state' | 'sessions' | 'android'>;

/**
 * One peripheral's native handle (plan §4.5). Operations JS may cancel (an `AbortSignal`) take an
 * `operationId`, which `cancelOperation` uses; null when nothing can cancel them.
 */
export interface NativePeripheralPort {
  readonly id: string;
  /** The latest advertised name, or the name the device reports once connected. */
  readonly name: string | null;
  readonly state: ConnectionState;
  /** The discovery cache; empty before discovery and after a disconnect. */
  readonly services: Service[];
  /** ATT MTU: 23 until connected; set when `connected` is emitted, then changes come as `mtuChange`. */
  readonly mtu: number;
  /** Resolves when the connection is ready; the `connected` event comes first. */
  connect(options: NativeConnectOptions): Promise<void>;
  /** During a connect, cancels it: the connect rejects with OPERATION_CANCELLED. */
  disconnect(): Promise<void>;
  /** `services` null discovers everything. */
  discover(
    services: string[] | null,
    timeoutMs: number,
    operationId: number | null
  ): Promise<Service[]>;
  read(request: NativeAttributeRequest): Promise<Uint8Array>;
  write(request: NativeAttributeRequest, value: Uint8Array): Promise<void>;
  /**
   * Writes `data` in chunks of `chunkSize` bytes (null: one packet), each one write through the
   * queue; the next chunk keeps its place ahead of later operations. Progress comes as
   * `streamProgress` events with `request.operationId`, about every 1 % and at the end.
   */
  writeStream(
    request: NativeAttributeRequest,
    data: Uint8Array,
    chunkSize: number | null
  ): Promise<void>;
  readDescriptor(request: NativeAttributeRequest): Promise<Uint8Array>;
  writeDescriptor(request: NativeAttributeRequest, value: Uint8Array): Promise<void>;
  /**
   * JS numbers its subscriptions. The first on a characteristic enables the CCCD; values then
   * arrive as `notification` events, once per value whatever the number of subscribers.
   */
  subscribe(
    request: NativeAttributeRequest,
    subscriptionId: number,
    mode: NativeSubscribeMode
  ): Promise<void>;
  /** The last subscriber of a characteristic disables its CCCD; unknown ids resolve. */
  unsubscribe(subscriptionId: number, timeoutMs: number): Promise<void>;
  /**
   * `mtu` is 23–517. Android negotiates and resolves the agreed MTU; iOS can't negotiate and
   * resolves the current one (`timeoutMs` unused).
   */
  requestMtu(mtu: number, timeoutMs: number, operationId: number | null): Promise<number>;
  /** Android only (hidden API, P2-06): clears the GATT cache and discovers again; false without it. */
  refreshGattCache(): Promise<boolean>;
  /** The link's RSSI in dBm. */
  readRssi(timeoutMs: number, operationId: number | null): Promise<number>;
  /**
   * A queued operation is removed; a running one rejects at once with OPERATION_CANCELLED while
   * the radio finishes it. Unknown or finished ids do nothing.
   */
  cancelOperation(operationId: number): Promise<void>;
  addListener<E extends keyof PeripheralObjectEvents>(
    event: E,
    listener: PeripheralObjectEvents[E]
  ): Subscription;
}

export type { ConnectionStateEvent, MtuChangeEvent, NotificationEvent };

/** The GATT server's native handle (P4-01). Answers go back by request id; the core slices reads. */
export interface NativeGattServerPort {
  respondToRead(requestId: number, value: Uint8Array | null, attError: number | null): void;
  respondToWrite(requestId: number, attError: number | null): void;
  /** P4-02: resolves once every subscribed target took the value. */
  notify(characteristic: string, value: Uint8Array, centrals: string[] | null): Promise<void>;
  close(): Promise<void>;
  addListener<E extends keyof GattServerObjectEvents>(
    event: E,
    listener: GattServerObjectEvents[E]
  ): Subscription;
}
