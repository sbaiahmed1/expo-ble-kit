import type {
  ConnectionStateEvent,
  ExpoBleKitModuleEvents,
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
import type { NativeAttributeRequest } from './attributeRequest';
import type { NativeConnectOptions } from './connectOptions';
import type { NativeScanOptions } from './scanOptions';

/**
 * What the TS layer needs from the native side (plan §4.6). The native module implements it, and so
 * does `FakeBleAdapter` for tests. Native binding tasks extend it as they land (P1-08
 * notifications, P1-09 MTU and RSSI).
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
  addListener<E extends keyof PeripheralObjectEvents>(
    event: E,
    listener: PeripheralObjectEvents[E]
  ): Subscription;
}

export type { ConnectionStateEvent };
