/**
 * Bluetooth Low Energy for Expo and React Native: scan, connect, read, write and subscribe, with
 * typed errors and React hooks. Start with {@link BleManager}, or the hooks for components.
 *
 * @module expo-ble-kit
 */
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
  BackgroundTaskOptions,
  BleBackgroundEvent,
  BleManagerApi,
  BlePermissionRequest,
  BlePermissions,
  BatchOptions,
  BleState,
  Characteristic,
  CharacteristicProperty,
  CharacteristicSubscription,
  ConnectionState,
  ConnectOptions,
  Descriptor,
  Diagnostics,
  ForegroundServiceNotification,
  LogEntry,
  LogLevel,
  NotificationBatch,
  OpOptions,
  Peripheral,
  PermissionStatus,
  Phy,
  ReconnectPolicy,
  ScanOptions,
  ScanResult,
  ScanSession,
  Service,
  StreamOptions,
  SubscribeOptions,
  Subscription,
  WriteOptions,
} from './types';
export { BleError, BleErrorCode } from './errors';
export type { BleErrorDetails } from './errors';
export { normalizeUUID, uuid16 } from './uuid';
export type { UUID } from './uuid';
export { GattServices, GattCharacteristics } from './constants';
