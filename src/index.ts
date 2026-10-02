// Reexport the native module. On web, it will be resolved to ExpoBleKitModule.web.ts
// and on native platforms to ExpoBleKitModule.ts
export { default } from './ExpoBleKitModule';
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
} from './types';
export { BleError, BleErrorCode } from './errors';
export type { BleErrorDetails } from './errors';
export { normalizeUUID, uuid16 } from './uuid';
export type { UUID } from './uuid';
export { GattServices, GattCharacteristics } from './constants';
