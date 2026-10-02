// The raw native module, resolved on first use (plan §4.6). Temporary: the public API of P1-12
// (BleManager, Peripheral, hooks) replaces this default export.
export { lazyNativeModule as default } from './internal/native';
export * from './ExpoBleKit.types';
export type {
  BlePermissionRequest,
  BlePermissions,
  BleState,
  Characteristic,
  CharacteristicProperty,
  ConnectionState,
  ConnectOptions,
  Diagnostics,
  OpOptions,
  PermissionStatus,
  Descriptor,
  Phy,
  ReconnectPolicy,
  ScanOptions,
  ScanResult,
  ScanSession,
  Service,
  Subscription,
  WriteOptions,
} from './types';
export { BleError, BleErrorCode } from './errors';
export type { BleErrorDetails } from './errors';
export { normalizeUUID, uuid16 } from './uuid';
export type { UUID } from './uuid';
export { GattServices, GattCharacteristics } from './constants';
