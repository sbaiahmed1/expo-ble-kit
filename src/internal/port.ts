import type {
  ConnectionStateEvent,
  ExpoBleKitModuleEvents,
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
  Service,
  Subscription,
} from '../types';
import type { NativeAttributeRequest, NativeSubscribeMode } from './attributeRequest';
import type { NativeConnectOptions } from './connectOptions';
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
  /** So far: state, sessions and, on Android, open GATT clients. The rest lands with P2-07. */
  getDiagnosticsAsync(): Promise<NativeDiagnostics>;
  addListener<E extends keyof ExpoBleKitModuleEvents>(
    event: E,
    listener: ExpoBleKitModuleEvents[E]
  ): Subscription;
}

export type NativeDiagnostics = Pick<Diagnostics, 'state' | 'sessions' | 'android'>;

/** One peripheral's native handle (plan §4.5). */
export interface NativePeripheralPort {
  readonly id: string;
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
  discover(services: string[] | null, timeoutMs: number): Promise<Service[]>;
  read(request: NativeAttributeRequest): Promise<Uint8Array>;
  write(request: NativeAttributeRequest, value: Uint8Array): Promise<void>;
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
  requestMtu(mtu: number, timeoutMs: number): Promise<number>;
  /** The link's RSSI in dBm. */
  readRssi(timeoutMs: number): Promise<number>;
  addListener<E extends keyof PeripheralObjectEvents>(
    event: E,
    listener: PeripheralObjectEvents[E]
  ): Subscription;
}

export type { ConnectionStateEvent, MtuChangeEvent, NotificationEvent };
