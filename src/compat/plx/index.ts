/**
 * A react-native-ble-plx 3.5.1 compatible API over expo-ble-kit, so an app moves by changing its
 * imports from `react-native-ble-plx` to `expo-ble-kit/compat/plx`. Values stay base64 strings, as
 * in ble-plx. What differs is listed in the migration guide (docs/guides/migration-from-plx.md).
 *
 * @module expo-ble-kit/compat/plx
 */
export {
  BleError,
  BleErrorCode,
  BleAndroidErrorCode,
  BleIOSErrorCode,
  BleATTErrorCode,
} from './BleError';
export type { BleErrorCodeMessageMapping, NativeBleError } from './BleError';
export { BleManager } from './BleManager';
export { Device } from './Device';
export { Service } from './Service';
export { Characteristic } from './Characteristic';
export { Descriptor } from './Descriptor';
export {
  fullUUID,
  State,
  LogLevel,
  ConnectionPriority,
  ScanCallbackType,
  ScanMode,
} from './TypeDefinition';
export type {
  Base64,
  BleManagerOptions,
  BleRestoredState,
  CharacteristicSubscriptionType,
  ConnectionOptions,
  DeviceId,
  Identifier,
  NativeCharacteristic,
  NativeDescriptor,
  NativeDevice,
  NativeService,
  RefreshGattMoment,
  ScanOptions,
  Subscription,
  TransactionId,
  UUID,
} from './TypeDefinition';
