import { NativeModule, requireNativeModule, SharedObject } from 'expo';

import type { ExpoBleKitModuleEvents, PeripheralObjectEvents } from './ExpoBleKit.types';
import type { NativeConnectOptions } from './internal/connectOptions';
import type { NativeScanOptions } from './internal/scanOptions';
import type {
  BlePermissionRequest,
  BlePermissions,
  BleState,
  ConnectionState,
  Diagnostics,
  Service,
} from './types';

/** One peripheral's native handle (plan §4.5): the same object for the same id. */
export declare class NativePeripheral extends SharedObject<PeripheralObjectEvents> {
  readonly id: string;
  readonly state: ConnectionState;
  /** The discovery cache; empty before discovery and after a disconnect. */
  readonly services: Service[];
  /** Resolves when the connection is ready; the `connected` event comes first. */
  connect(options: NativeConnectOptions): Promise<void>;
  /** During a connect, cancels it: the connect rejects with OPERATION_CANCELLED. */
  disconnect(): Promise<void>;
  /** `services` null discovers everything. UUIDs must be normalized; the timeout is required. */
  discover(services: string[] | null, timeoutMs: number): Promise<Service[]>;
}

// The raw native module. Its rejections carry a BleErrorCode `code`; convert them with
// `BleError.fromNative`. The public BleManager (P1-12) wraps this.
declare class ExpoBleKitModule extends NativeModule<ExpoBleKitModuleEvents> {
  getState(): BleState;
  getPermissionsAsync(): Promise<BlePermissions>;
  requestPermissionsAsync(request?: BlePermissionRequest): Promise<BlePermissions>;
  /** Results and the session's end arrive as `scanResults` and `scanError` events. */
  startScan(sessionId: number, options: NativeScanOptions): Promise<void>;
  stopScan(sessionId: number): Promise<void>;
  /** No I/O; never creates a manager (plan §5.2). */
  getPeripheral(id: string): NativePeripheral;
  /** So far: state, sessions and, on Android, open GATT clients. The rest lands with P2-07. */
  getDiagnosticsAsync(): Promise<Pick<Diagnostics, 'state' | 'sessions' | 'android'>>;
}

export default requireNativeModule<ExpoBleKitModule>('ExpoBleKit');
