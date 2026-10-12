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
  AccessoryPickerItem,
  Advertisement,
  AdvertisingData,
  AdvertisingOptions,
  AttributePermission,
  BackgroundTaskOptions,
  BleBackgroundEvent,
  BleManagerApi,
  BlePermissionRequest,
  BlePermissions,
  BatchOptions,
  BleState,
  Characteristic,
  CharacteristicDefinition,
  CharacteristicProperty,
  CharacteristicSubscription,
  ConnectionState,
  ConnectOptions,
  Descriptor,
  Diagnostics,
  RestorationJournalEntry,
  ForegroundServiceNotification,
  GattServer,
  L2CAPChannel,
  L2CAPServer,
  LogEntry,
  LogLevel,
  NotificationBatch,
  OpOptions,
  Peripheral,
  PermissionStatus,
  Phy,
  ReadRequest,
  ReconnectPolicy,
  ScanOptions,
  ScanResult,
  ScanSession,
  Service,
  ServiceDefinition,
  StreamOptions,
  SubscribeOptions,
  Subscription,
  WriteOptions,
  WriteRequest,
} from './types';
export { BleError, BleErrorCode } from './errors';
export type { BleErrorDetails } from './errors';
export { normalizeUUID, uuid16 } from './uuid';
export type { UUID } from './uuid';
export { GattServices, GattCharacteristics } from './constants';
