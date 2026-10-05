import { NativeModule, requireOptionalNativeModule, SharedObject } from 'expo';

import type {
  ExpoBleKitModuleEvents,
  GattServerObjectEvents,
  PeripheralObjectEvents,
} from './ExpoBleKit.types';
import type { NativeAdvertisingData, NativeAdvertisingOptions } from './internal/advertising';
import type { NativeAttributeRequest, NativeSubscribeMode } from './internal/attributeRequest';
import type { NativeConnectOptions } from './internal/connectOptions';
import type { NativeServiceDefinition } from './internal/gattServer';
import type {
  NativeBleKitPort,
  NativeDiagnostics,
  NativeGattServerPort,
  NativePeripheralPort,
} from './internal/port';
import type { NativeScanOptions } from './internal/scanOptions';
import type {
  BlePermissionRequest,
  BlePermissions,
  BleState,
  ConnectionState,
  LogLevel,
  Service,
} from './types';

/** One peripheral's native handle (plan §4.5): the same object for the same id. */
export declare class NativePeripheral
  extends SharedObject<PeripheralObjectEvents>
  implements NativePeripheralPort
{
  readonly id: string;
  readonly name: string | null;
  readonly state: ConnectionState;
  readonly services: Service[];
  readonly mtu: number;
  connect(options: NativeConnectOptions): Promise<void>;
  disconnect(): Promise<void>;
  discover(
    services: string[] | null,
    timeoutMs: number,
    operationId: number | null
  ): Promise<Service[]>;
  read(request: NativeAttributeRequest): Promise<Uint8Array>;
  write(request: NativeAttributeRequest, value: Uint8Array): Promise<void>;
  writeStream(
    request: NativeAttributeRequest,
    data: Uint8Array,
    chunkSize: number | null
  ): Promise<void>;
  readDescriptor(request: NativeAttributeRequest): Promise<Uint8Array>;
  writeDescriptor(request: NativeAttributeRequest, value: Uint8Array): Promise<void>;
  subscribe(
    request: NativeAttributeRequest,
    subscriptionId: number,
    mode: NativeSubscribeMode
  ): Promise<void>;
  unsubscribe(subscriptionId: number, timeoutMs: number): Promise<void>;
  requestMtu(mtu: number, timeoutMs: number, operationId: number | null): Promise<number>;
  readRssi(timeoutMs: number, operationId: number | null): Promise<number>;
  refreshGattCache(): Promise<boolean>;
  cancelOperation(operationId: number): Promise<void>;
}

/** The GATT server's native handle (plan §4.5, P4-01). */
export declare class NativeGattServer
  extends SharedObject<GattServerObjectEvents>
  implements NativeGattServerPort
{
  respondToRead(requestId: number, value: Uint8Array | null, attError: number | null): void;
  respondToWrite(requestId: number, attError: number | null): void;
  notify(characteristic: string, value: Uint8Array, centrals: string[] | null): Promise<void>;
  close(): Promise<void>;
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
  getKnownPeripherals(ids: string[]): Promise<string[]>;
  getSystemConnectedPeripherals(services: string[]): Promise<string[]>;
  getDiagnosticsAsync(): Promise<NativeDiagnostics>;
  openGattServer(services: NativeServiceDefinition[]): Promise<NativeGattServer>;
  startAdvertising(data: NativeAdvertisingData, options: NativeAdvertisingOptions): Promise<number>;
  stopAdvertising(id: number): Promise<void>;
  setLogLevel(level: LogLevel): void;
  setLogForwarding(enabled: boolean): void;
}

/** Null where the module isn't linked: Jest, or an app that wasn't rebuilt (plan §4.6). */
export function loadNativeModule(): NativeBleKitPort | null {
  return requireOptionalNativeModule<ExpoBleKitModule>('ExpoBleKit');
}
