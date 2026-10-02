import { NativeModule, requireOptionalNativeModule, SharedObject } from 'expo';

import type { ExpoBleKitModuleEvents, PeripheralObjectEvents } from './ExpoBleKit.types';
import type { NativeAttributeRequest } from './internal/attributeRequest';
import type { NativeConnectOptions } from './internal/connectOptions';
import type { NativeBleKitPort, NativeDiagnostics, NativePeripheralPort } from './internal/port';
import type { NativeScanOptions } from './internal/scanOptions';
import type {
  BlePermissionRequest,
  BlePermissions,
  BleState,
  ConnectionState,
  Service,
} from './types';

/** One peripheral's native handle (plan §4.5): the same object for the same id. */
export declare class NativePeripheral
  extends SharedObject<PeripheralObjectEvents>
  implements NativePeripheralPort
{
  readonly id: string;
  readonly state: ConnectionState;
  readonly services: Service[];
  connect(options: NativeConnectOptions): Promise<void>;
  disconnect(): Promise<void>;
  discover(services: string[] | null, timeoutMs: number): Promise<Service[]>;
  read(request: NativeAttributeRequest): Promise<Uint8Array>;
  write(request: NativeAttributeRequest, value: Uint8Array): Promise<void>;
  readDescriptor(request: NativeAttributeRequest): Promise<Uint8Array>;
  writeDescriptor(request: NativeAttributeRequest, value: Uint8Array): Promise<void>;
}

/** The native module: the real `NativeBleKitPort` (plan §4.6). */
export declare class ExpoBleKitModule
  extends NativeModule<ExpoBleKitModuleEvents>
  implements NativeBleKitPort
{
  getState(): BleState;
  getPermissionsAsync(): Promise<BlePermissions>;
  requestPermissionsAsync(request?: BlePermissionRequest): Promise<BlePermissions>;
  startScan(sessionId: number, options: NativeScanOptions): Promise<void>;
  stopScan(sessionId: number): Promise<void>;
  getPeripheral(id: string): NativePeripheral;
  getDiagnosticsAsync(): Promise<NativeDiagnostics>;
}

/** Null where the module isn't linked: Jest, or an app that wasn't rebuilt (plan §4.6). */
export function loadNativeModule(): NativeBleKitPort | null {
  return requireOptionalNativeModule<ExpoBleKitModule>('ExpoBleKit');
}
