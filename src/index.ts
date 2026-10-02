// The public API (plan §5). Everything else is internal.
export { BleManager } from './BleManager';
export {
  useBleState,
  useBlePermissions,
  useScan,
  usePeripheral,
  useCharacteristicValue,
} from './hooks';
export type {
  BleManagerApi,
  BlePermissionRequest,
  BlePermissions,
  BleState,
  Characteristic,
  CharacteristicProperty,
  CharacteristicSubscription,
  ConnectionState,
  ConnectOptions,
  Descriptor,
  Diagnostics,
  OpOptions,
  Peripheral,
  PermissionStatus,
  Phy,
  ReconnectPolicy,
  ScanOptions,
  ScanResult,
  ScanSession,
  Service,
  SubscribeOptions,
  Subscription,
  WriteOptions,
} from './types';
export { BleError, BleErrorCode } from './errors';
export type { BleErrorDetails } from './errors';
export { normalizeUUID, uuid16 } from './uuid';
export type { UUID } from './uuid';
export { GattServices, GattCharacteristics } from './constants';
