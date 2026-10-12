import { BleError as KitError, BleErrorCode as KitCode } from '../../errors';

// ble-plx's errors (react-native-ble-plx 3.5.1, Apache-2.0): the same class shape, numeric codes and
// default messages, so app code that checks `error.errorCode` or shows `error.message` works
// unchanged. expo-ble-kit's errors are converted with `toPlxError`.

/** ble-plx's error codes: `BleError.errorCode` is one of these numbers. */
export const BleErrorCode = {
  /** An unexpected error; `reason` has the details. */
  UnknownError: 0,
  /** The manager was destroyed while the call was in progress. */
  BluetoothManagerDestroyed: 1,
  /** Cancelled: a removed monitor, `cancelTransaction`, or a call replaced by one with the same transaction id. */
  OperationCancelled: 2,
  /** The call took longer than its timeout. */
  OperationTimedOut: 3,
  /** The call couldn't start. */
  OperationStartFailed: 4,
  /** An invalid UUID or argument. */
  InvalidIdentifiers: 5,
  /** The device has no Bluetooth LE. */
  BluetoothUnsupported: 100,
  /** The app may not use Bluetooth, or lacks a permission. */
  BluetoothUnauthorized: 101,
  /** Bluetooth is off. */
  BluetoothPoweredOff: 102,
  /** Bluetooth's state isn't known yet. */
  BluetoothInUnknownState: 103,
  /** Bluetooth is restarting. */
  BluetoothResetting: 104,
  /** Bluetooth couldn't be turned on or off (`enable`, `disable`). */
  BluetoothStateChangeFailed: 105,
  /** The connection failed. */
  DeviceConnectionFailed: 200,
  /** The device disconnected. */
  DeviceDisconnected: 201,
  /** Reading the RSSI failed. */
  DeviceRSSIReadFailed: 202,
  /** The device is already connected. */
  DeviceAlreadyConnected: 203,
  /** The system doesn't know the device. */
  DeviceNotFound: 204,
  /** The call needs a connection. */
  DeviceNotConnected: 205,
  /** The MTU request failed. */
  DeviceMTUChangeFailed: 206,
  /** Service discovery failed. */
  ServicesDiscoveryFailed: 300,
  /** Included service discovery failed. */
  IncludedServicesDiscoveryFailed: 301,
  /** The device has no such service. */
  ServiceNotFound: 302,
  /** Services weren't discovered yet. */
  ServicesNotDiscovered: 303,
  /** Characteristic discovery failed. */
  CharacteristicsDiscoveryFailed: 400,
  /** The characteristic write failed; `attErrorCode` says why when the device answered. */
  CharacteristicWriteFailed: 401,
  /** The characteristic read failed; `attErrorCode` says why when the device answered. */
  CharacteristicReadFailed: 402,
  /** Turning notifications on failed. */
  CharacteristicNotifyChangeFailed: 403,
  /** The service has no such characteristic. */
  CharacteristicNotFound: 404,
  /** Characteristics weren't discovered yet. */
  CharacteristicsNotDiscovered: 405,
  /** The value isn't base64. */
  CharacteristicInvalidDataFormat: 406,
  /** Descriptor discovery failed. */
  DescriptorsDiscoveryFailed: 500,
  /** The descriptor write failed. */
  DescriptorWriteFailed: 501,
  /** The descriptor read failed. */
  DescriptorReadFailed: 502,
  /** The characteristic has no such descriptor. */
  DescriptorNotFound: 503,
  /** Descriptors weren't discovered yet. */
  DescriptorsNotDiscovered: 504,
  /** The value isn't base64. */
  DescriptorInvalidDataFormat: 505,
  /** The CCCD (0x2902) can't be written: monitor the characteristic instead. */
  DescriptorWriteNotAllowed: 506,
  /** Scanning couldn't start, or stopped. */
  ScanStartFailed: 600,
  /** Location services are off (old Android versions need them for scanning). */
  LocationServicesDisabled: 601,
} as const;
/** One of {@link BleErrorCode}'s values. */
// eslint-disable-next-line @typescript-eslint/no-redeclare
export type BleErrorCode = (typeof BleErrorCode)[keyof typeof BleErrorCode];

/** The ATT error the device answered with, in `BleError.attErrorCode`. */
export const BleATTErrorCode = {
  /** ATT error 0x00. */
  Success: 0,
  /** ATT error 0x01. */
  InvalidHandle: 1,
  /** ATT error 0x02. */
  ReadNotPermitted: 2,
  /** ATT error 0x03. */
  WriteNotPermitted: 3,
  /** ATT error 0x04. */
  InvalidPdu: 4,
  /** ATT error 0x05. */
  InsufficientAuthentication: 5,
  /** ATT error 0x06. */
  RequestNotSupported: 6,
  /** ATT error 0x07. */
  InvalidOffset: 7,
  /** ATT error 0x08. */
  InsufficientAuthorization: 8,
  /** ATT error 0x09. */
  PrepareQueueFull: 9,
  /** ATT error 0x0a. */
  AttributeNotFound: 10,
  /** ATT error 0x0b. */
  AttributeNotLong: 11,
  /** ATT error 0x0c. */
  InsufficientEncryptionKeySize: 12,
  /** ATT error 0x0d. */
  InvalidAttributeValueLength: 13,
  /** ATT error 0x0e. */
  UnlikelyError: 14,
  /** ATT error 0x0f. */
  InsufficientEncryption: 15,
  /** ATT error 0x10. */
  UnsupportedGroupType: 16,
  /** ATT error 0x11. */
  InsufficientResources: 17,
} as const;
/** One of {@link BleATTErrorCode}'s values. */
// eslint-disable-next-line @typescript-eslint/no-redeclare
export type BleATTErrorCode = (typeof BleATTErrorCode)[keyof typeof BleATTErrorCode];

/** The CoreBluetooth error, in `BleError.iosErrorCode`. */
export const BleIOSErrorCode = {
  /** CoreBluetooth `CBError` 0. */
  Unknown: 0,
  /** CoreBluetooth `CBError` 1. */
  InvalidParameters: 1,
  /** CoreBluetooth `CBError` 2. */
  InvalidHandle: 2,
  /** CoreBluetooth `CBError` 3. */
  NotConnected: 3,
  /** CoreBluetooth `CBError` 4. */
  OutOfSpace: 4,
  /** CoreBluetooth `CBError` 5. */
  OperationCancelled: 5,
  /** CoreBluetooth `CBError` 6. */
  ConnectionTimeout: 6,
  /** CoreBluetooth `CBError` 7. */
  PeripheralDisconnected: 7,
  /** CoreBluetooth `CBError` 8. */
  UuidNotAllowed: 8,
  /** CoreBluetooth `CBError` 9. */
  AlreadyAdvertising: 9,
  /** CoreBluetooth `CBError` 10. */
  ConnectionFailed: 10,
  /** CoreBluetooth `CBError` 11. */
  ConnectionLimitReached: 11,
  /** CoreBluetooth `CBError` 12. */
  UnknownDevice: 12,
} as const;
/** One of {@link BleIOSErrorCode}'s values. */
// eslint-disable-next-line @typescript-eslint/no-redeclare
export type BleIOSErrorCode = (typeof BleIOSErrorCode)[keyof typeof BleIOSErrorCode];

/** The Android GATT status, in `BleError.androidErrorCode`. */
export const BleAndroidErrorCode = {
  /** Android GATT status 0x80. */
  NoResources: 0x80,
  /** Android GATT status 0x81. */
  InternalError: 0x81,
  /** Android GATT status 0x82. */
  WrongState: 0x82,
  /** Android GATT status 0x83. */
  DbFull: 0x83,
  /** Android GATT status 0x84. */
  Busy: 0x84,
  /** Android GATT status 0x85. */
  Error: 0x85,
  /** Android GATT status 0x86. */
  CmdStarted: 0x86,
  /** Android GATT status 0x87. */
  IllegalParameter: 0x87,
  /** Android GATT status 0x88. */
  Pending: 0x88,
  /** Android GATT status 0x89. */
  AuthFail: 0x89,
  /** Android GATT status 0x8a. */
  More: 0x8a,
  /** Android GATT status 0x8b. */
  InvalidCfg: 0x8b,
  /** Android GATT status 0x8c. */
  ServiceStarted: 0x8c,
  /** Android GATT status 0x8d. */
  EncrypedNoMitm: 0x8d,
  /** Android GATT status 0x8e. */
  NotEncrypted: 0x8e,
  /** Android GATT status 0x8f. */
  Congested: 0x8f,
} as const;
/** One of {@link BleAndroidErrorCode}'s values. */
// eslint-disable-next-line @typescript-eslint/no-redeclare
export type BleAndroidErrorCode = (typeof BleAndroidErrorCode)[keyof typeof BleAndroidErrorCode];

/** Messages by error code, with `{deviceID}`, `{serviceUUID}` and the like filled in. */
export type BleErrorCodeMessageMapping = { [code: number]: string };

/** What a native ble-plx error carries; also what `BleError`'s constructor takes. */
export interface NativeBleError {
  /** The error code. */
  errorCode: BleErrorCode;
  /** The ATT error the device answered with, if any. */
  attErrorCode: BleATTErrorCode | null;
  /** The CoreBluetooth error code, if any. */
  iosErrorCode: BleIOSErrorCode | null;
  /** The Android GATT status, if any. */
  androidErrorCode: BleAndroidErrorCode | null;
  /** What went wrong, in expo-ble-kit's words. */
  reason: string | null;
  /** The device, for the message. */
  deviceID?: string;
  /** The service, for the message. */
  serviceUUID?: string;
  /** The characteristic, for the message. */
  characteristicUUID?: string;
  /** The descriptor, for the message. */
  descriptorUUID?: string;
  /** Details, for the message. */
  internalMessage?: string;
}

export const BleErrorCodeMessage: BleErrorCodeMessageMapping = {
  [BleErrorCode.UnknownError]:
    'Unknown error occurred. This is probably a bug! Check reason property.',
  [BleErrorCode.BluetoothManagerDestroyed]: 'BleManager was destroyed',
  [BleErrorCode.OperationCancelled]: 'Operation was cancelled',
  [BleErrorCode.OperationTimedOut]: 'Operation timed out',
  [BleErrorCode.OperationStartFailed]: 'Operation was rejected',
  [BleErrorCode.InvalidIdentifiers]: 'Invalid UUIDs or IDs were passed: {internalMessage}',
  [BleErrorCode.BluetoothUnsupported]: 'BluetoothLE is unsupported on this device',
  [BleErrorCode.BluetoothUnauthorized]: 'Device is not authorized to use BluetoothLE',
  [BleErrorCode.BluetoothPoweredOff]: 'BluetoothLE is powered off',
  [BleErrorCode.BluetoothInUnknownState]: 'BluetoothLE is in unknown state',
  [BleErrorCode.BluetoothResetting]: 'BluetoothLE is resetting',
  [BleErrorCode.BluetoothStateChangeFailed]: 'Bluetooth state change failed',
  [BleErrorCode.DeviceConnectionFailed]: 'Device {deviceID} connection failed',
  [BleErrorCode.DeviceDisconnected]: 'Device {deviceID} was disconnected',
  [BleErrorCode.DeviceRSSIReadFailed]: 'RSSI read failed for device {deviceID}',
  [BleErrorCode.DeviceAlreadyConnected]: 'Device {deviceID} is already connected',
  [BleErrorCode.DeviceNotFound]: 'Device {deviceID} not found',
  [BleErrorCode.DeviceNotConnected]: 'Device {deviceID} is not connected',
  [BleErrorCode.DeviceMTUChangeFailed]: 'Device {deviceID} could not change MTU size',
  [BleErrorCode.ServicesDiscoveryFailed]: 'Services discovery failed for device {deviceID}',
  [BleErrorCode.IncludedServicesDiscoveryFailed]:
    'Included services discovery failed for device {deviceID} and service: {serviceUUID}',
  [BleErrorCode.ServiceNotFound]: 'Service {serviceUUID} for device {deviceID} not found',
  [BleErrorCode.ServicesNotDiscovered]: 'Services not discovered for device {deviceID}',
  [BleErrorCode.CharacteristicsDiscoveryFailed]:
    'Characteristic discovery failed for device {deviceID} and service {serviceUUID}',
  [BleErrorCode.CharacteristicWriteFailed]:
    'Characteristic {characteristicUUID} write failed for device {deviceID} and service {serviceUUID}',
  [BleErrorCode.CharacteristicReadFailed]:
    'Characteristic {characteristicUUID} read failed for device {deviceID} and service {serviceUUID}',
  [BleErrorCode.CharacteristicNotifyChangeFailed]:
    'Characteristic {characteristicUUID} notify change failed for device {deviceID} and service {serviceUUID}',
  [BleErrorCode.CharacteristicNotFound]: 'Characteristic {characteristicUUID} not found',
  [BleErrorCode.CharacteristicsNotDiscovered]:
    'Characteristics not discovered for device {deviceID} and service {serviceUUID}',
  [BleErrorCode.CharacteristicInvalidDataFormat]:
    'Cannot write to characteristic {characteristicUUID} with invalid data format: {internalMessage}',
  [BleErrorCode.DescriptorsDiscoveryFailed]:
    'Descriptor {descriptorUUID} discovery failed for device {deviceID}, service {serviceUUID} and characteristic {characteristicUUID}',
  [BleErrorCode.DescriptorWriteFailed]:
    'Descriptor {descriptorUUID} write failed for device {deviceID}, service {serviceUUID} and characteristic {characteristicUUID}',
  [BleErrorCode.DescriptorReadFailed]:
    'Descriptor {descriptorUUID} read failed for device {deviceID}, service {serviceUUID} and characteristic {characteristicUUID}',
  [BleErrorCode.DescriptorNotFound]: 'Descriptor {descriptorUUID} not found',
  [BleErrorCode.DescriptorsNotDiscovered]:
    'Descriptors not discovered for device {deviceID}, service {serviceUUID} and characteristic {characteristicUUID}',
  [BleErrorCode.DescriptorInvalidDataFormat]:
    'Cannot write to descriptor {descriptorUUID} with invalid data format: {internalMessage}',
  [BleErrorCode.DescriptorWriteNotAllowed]:
    "Cannot write to descriptor {descriptorUUID}. It's not allowed by iOS and therefore forbidden on Android as well.",
  [BleErrorCode.ScanStartFailed]: 'Cannot start scanning operation',
  [BleErrorCode.LocationServicesDisabled]: 'Location services are disabled',
};

function fill(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const value = values[key];
    return typeof value === 'string' && value ? value : '?';
  });
}

/** ble-plx's error: `errorCode` (a number of `BleErrorCode`), the native codes, and `reason`. */
export class BleError extends Error {
  /** One of {@link BleErrorCode}. */
  errorCode: BleErrorCode;
  /** The ATT error the device answered with, if any. */
  attErrorCode: BleATTErrorCode | null;
  /** The CoreBluetooth error code, if any. */
  iosErrorCode: BleIOSErrorCode | null;
  /** The Android GATT status, if any. */
  androidErrorCode: BleAndroidErrorCode | null;
  /** What went wrong, in expo-ble-kit's words (the original error is `cause`). */
  reason: string | null;

  constructor(
    nativeBleError: NativeBleError | string,
    errorMessageMapping: BleErrorCodeMessageMapping = BleErrorCodeMessage
  ) {
    super(errorMessageMapping[BleErrorCode.UnknownError]);
    this.name = 'BleError';
    if (typeof nativeBleError === 'string') {
      this.errorCode = BleErrorCode.UnknownError;
      this.attErrorCode = null;
      this.iosErrorCode = null;
      this.androidErrorCode = null;
      this.reason = nativeBleError;
    } else {
      const template = errorMessageMapping[nativeBleError.errorCode];
      if (template) this.message = fill(template, { ...nativeBleError });
      this.errorCode = nativeBleError.errorCode;
      this.attErrorCode = nativeBleError.attErrorCode;
      this.iosErrorCode = nativeBleError.iosErrorCode;
      this.androidErrorCode = nativeBleError.androidErrorCode;
      this.reason = nativeBleError.reason;
    }
  }
}

/** Which call failed: codes that mean "the attribute operation failed" depend on it. */
export type OperationKind =
  | 'connect'
  | 'discover'
  | 'read'
  | 'write'
  | 'monitor'
  | 'readDescriptor'
  | 'writeDescriptor'
  | 'rssi'
  | 'mtu'
  | 'scan'
  | 'other';

export type ErrorContext = {
  kind: OperationKind;
  deviceID?: string;
  serviceUUID?: string;
  characteristicUUID?: string;
  descriptorUUID?: string;
};

const DIRECT: Partial<Record<KitCode, BleErrorCode>> = {
  OPERATION_CANCELLED: BleErrorCode.OperationCancelled,
  OPERATION_TIMEOUT: BleErrorCode.OperationTimedOut,
  CONNECTION_TIMEOUT: BleErrorCode.OperationTimedOut,
  BLUETOOTH_UNSUPPORTED: BleErrorCode.BluetoothUnsupported,
  BLUETOOTH_UNAUTHORIZED: BleErrorCode.BluetoothUnauthorized,
  PERMISSION_DENIED: BleErrorCode.BluetoothUnauthorized,
  BLUETOOTH_POWERED_OFF: BleErrorCode.BluetoothPoweredOff,
  BLUETOOTH_RESETTING: BleErrorCode.BluetoothResetting,
  PERIPHERAL_NOT_FOUND: BleErrorCode.DeviceNotFound,
  CONNECTION_FAILED: BleErrorCode.DeviceConnectionFailed,
  DISCONNECTED: BleErrorCode.DeviceDisconnected,
  SERVICE_NOT_FOUND: BleErrorCode.ServiceNotFound,
  CHARACTERISTIC_NOT_FOUND: BleErrorCode.CharacteristicNotFound,
  DESCRIPTOR_NOT_FOUND: BleErrorCode.DescriptorNotFound,
  SCAN_FAILED: BleErrorCode.ScanStartFailed,
  SCAN_THROTTLED: BleErrorCode.ScanStartFailed,
  INVALID_ARGUMENT: BleErrorCode.InvalidIdentifiers,
};

/** What a failed attribute operation is called in ble-plx, by operation. */
const FAILED: Record<OperationKind, BleErrorCode> = {
  connect: BleErrorCode.DeviceConnectionFailed,
  discover: BleErrorCode.ServicesDiscoveryFailed,
  read: BleErrorCode.CharacteristicReadFailed,
  write: BleErrorCode.CharacteristicWriteFailed,
  monitor: BleErrorCode.CharacteristicNotifyChangeFailed,
  readDescriptor: BleErrorCode.DescriptorReadFailed,
  writeDescriptor: BleErrorCode.DescriptorWriteFailed,
  rssi: BleErrorCode.DeviceRSSIReadFailed,
  mtu: BleErrorCode.DeviceMTUChangeFailed,
  scan: BleErrorCode.ScanStartFailed,
  other: BleErrorCode.UnknownError,
};

const ATT: Partial<Record<KitCode, BleATTErrorCode>> = {
  READ_NOT_PERMITTED: BleATTErrorCode.ReadNotPermitted,
  WRITE_NOT_PERMITTED: BleATTErrorCode.WriteNotPermitted,
  INSUFFICIENT_AUTHENTICATION: BleATTErrorCode.InsufficientAuthentication,
  INVALID_OFFSET: BleATTErrorCode.InvalidOffset,
  INSUFFICIENT_AUTHORIZATION: BleATTErrorCode.InsufficientAuthorization,
  INVALID_ATTRIBUTE_LENGTH: BleATTErrorCode.InvalidAttributeValueLength,
  INSUFFICIENT_ENCRYPTION: BleATTErrorCode.InsufficientEncryption,
};

/** A ble-plx error for `code`, with the context ble-plx's messages name. */
export function plxError(
  code: BleErrorCode,
  context: Partial<ErrorContext>,
  mapping: BleErrorCodeMessageMapping,
  reason: string | null = null,
  internalMessage?: string
): BleError {
  return new BleError(
    {
      errorCode: code,
      attErrorCode: null,
      iosErrorCode: null,
      androidErrorCode: null,
      reason,
      deviceID: context.deviceID,
      serviceUUID: context.serviceUUID,
      characteristicUUID: context.characteristicUUID,
      descriptorUUID: context.descriptorUUID,
      internalMessage,
    },
    mapping
  );
}

/** Converts what an expo-ble-kit call threw into ble-plx's error; ble-plx errors pass through. */
export function toPlxError(
  error: unknown,
  context: ErrorContext,
  mapping: BleErrorCodeMessageMapping
): BleError {
  if (error instanceof BleError) return error;
  const kit = KitError.fromNative(error);
  const { kind, deviceID, serviceUUID, characteristicUUID, descriptorUUID } = context;
  const attFromCode = ATT[kit.code];
  const attFromNative = kit.nativeDomain === 'CBATTErrorDomain' ? kit.nativeCode : undefined;
  const att = attFromCode ?? (attFromNative as BleATTErrorCode | undefined) ?? null;
  const code =
    kit.code === 'NOT_SUPPORTED' || kit.code === 'GATT_ERROR' || att !== null
      ? FAILED[kind]
      : (DIRECT[kit.code] ?? BleErrorCode.UnknownError);
  const converted = new BleError(
    {
      errorCode: code,
      attErrorCode: att,
      iosErrorCode:
        kit.nativeDomain === 'CBErrorDomain' ? ((kit.nativeCode ?? null) as BleIOSErrorCode) : null,
      androidErrorCode: (kit.gattStatus ?? null) as BleAndroidErrorCode | null,
      reason: kit.message,
      deviceID,
      serviceUUID,
      characteristicUUID,
      descriptorUUID,
      internalMessage: kit.message,
    },
    mapping
  );
  (converted as { cause?: unknown }).cause = kit;
  return converted;
}
