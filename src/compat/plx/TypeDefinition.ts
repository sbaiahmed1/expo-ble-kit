import type { BleErrorCodeMessageMapping } from './BleError';
import type { Device } from './Device';

// ble-plx's types and constants (react-native-ble-plx 3.5.1). The "enums" are plain objects with a
// type of the same name, so both `State.PoweredOn` and `'PoweredOn'` type-check.

/** A device's id: an address on Android, a UUID on iOS. */
export type DeviceId = string;
/** ble-plx's number for a service, characteristic or descriptor; stable per device and attribute. */
export type Identifier = number;
/** A UUID: 16-, 32- or 128-bit, any case. Results use the lowercase 128-bit form. */
export type UUID = string;
/** ble-plx passes values as base64 strings; expo-ble-kit itself uses `Uint8Array`. */
export type Base64 = string;
/** An id the app chooses for a call, so `cancelTransaction` can cancel it. */
export type TransactionId = string;
/** What `monitor…` asks for on Android; iOS chooses by itself. */
export type CharacteristicSubscriptionType = 'notification' | 'indication';
/** When `ConnectionOptions.refreshGatt` clears Android's GATT cache. */
export type RefreshGattMoment = 'OnConnected';

/** What listener functions return. */
export interface Subscription {
  /** Stops the listener (a monitor reports OperationCancelled to it, as in ble-plx). */
  remove(): void;
}

/** Bluetooth's state, as `state()` and `onStateChange` report it. */
export const State = {
  /** Not known yet. */
  Unknown: 'Unknown',
  /** Restarting. */
  Resetting: 'Resetting',
  /** No Bluetooth LE on this device. */
  Unsupported: 'Unsupported',
  /** The app may not use Bluetooth. */
  Unauthorized: 'Unauthorized',
  /** Bluetooth is off. */
  PoweredOff: 'PoweredOff',
  /** Bluetooth is on: everything works. */
  PoweredOn: 'PoweredOn',
} as const;
/** One of {@link State}'s values. */
// eslint-disable-next-line @typescript-eslint/no-redeclare
export type State = (typeof State)[keyof typeof State];

/** How much the native side logs (`setLogLevel`). */
export const LogLevel = {
  /** No log. */
  None: 'None',
  /** Everything. */
  Verbose: 'Verbose',
  /** Operations and their results. */
  Debug: 'Debug',
  /** Connections and state changes. */
  Info: 'Info',
  /** Problems the library recovered from (expo-ble-kit's default). */
  Warning: 'Warning',
  /** Failures only. */
  Error: 'Error',
} as const;
/** One of {@link LogLevel}'s values. */
// eslint-disable-next-line @typescript-eslint/no-redeclare
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

/** Android connection intervals (`requestConnectionPriority`). */
export const ConnectionPriority = {
  /** The default interval. */
  Balanced: 0,
  /** A short interval: faster, more battery. */
  High: 1,
  /** A long interval: slower, less battery. */
  LowPower: 2,
} as const;
/** One of {@link ConnectionPriority}'s values. */
// eslint-disable-next-line @typescript-eslint/no-redeclare
export type ConnectionPriority = (typeof ConnectionPriority)[keyof typeof ConnectionPriority];

/** Android scan modes (`ScanOptions.scanMode`). */
export const ScanMode = {
  /** Results only from other apps' scans. */
  Opportunistic: -1,
  /** Scans in short windows. */
  LowPower: 0,
  /** Between the two. */
  Balanced: 1,
  /** Scans all the time. */
  LowLatency: 2,
} as const;
/** One of {@link ScanMode}'s values. */
// eslint-disable-next-line @typescript-eslint/no-redeclare
export type ScanMode = (typeof ScanMode)[keyof typeof ScanMode];

/** Android scan callback types (`ScanOptions.callbackType`). */
export const ScanCallbackType = {
  /** Every advertisement. */
  AllMatches: 1,
  /** The first advertisement of each device. */
  FirstMatch: 2,
  /** When a device stops advertising. */
  MatchLost: 4,
} as const;
/** One of {@link ScanCallbackType}'s values. */
// eslint-disable-next-line @typescript-eslint/no-redeclare
export type ScanCallbackType = (typeof ScanCallbackType)[keyof typeof ScanCallbackType];

/** `startDeviceScan` options. */
export interface ScanOptions {
  /** iOS: report every advertisement. Android always does, as in ble-plx. */
  allowDuplicates?: boolean;
  /** Android only. */
  scanMode?: ScanMode;
  /** Android only. */
  callbackType?: ScanCallbackType;
  /** Android only: legacy advertisements only. */
  legacyScan?: boolean;
}

/** `connectToDevice` options. */
export interface ConnectionOptions {
  /** Android: connect whenever the device appears; without `timeout` it waits as long as it takes. */
  autoConnect?: boolean;
  /** Android: the MTU to ask for after connecting. */
  requestMTU?: number;
  /** Android: clear the GATT cache once connected (`'OnConnected'`). */
  refreshGatt?: RefreshGattMoment;
  /** Milliseconds. expo-ble-kit's default (15 s) applies when left out. */
  timeout?: number;
}

/** What `restoreStateFunction` receives. */
export interface BleRestoredState {
  /** The devices iOS reconnected. */
  connectedPeripherals: Device[];
}

/** `new BleManager()` options. */
export interface BleManagerOptions {
  /** iOS state restoration isn't available yet: `restoreStateFunction` is called with null. */
  restoreStateIdentifier?: string;
  /** Called once, with null for now (see `restoreStateIdentifier`). */
  restoreStateFunction?: (restoredState: BleRestoredState | null) => void;
  /** The app's own messages by error code; `{deviceID}` and the other names are filled in. */
  errorCodesToMessagesMapping?: BleErrorCodeMessageMapping;
}

/** A device's fields, as `Device` carries them. */
export interface NativeDevice {
  /** Its id. */
  id: DeviceId;
  /** Its name, when known. */
  name: string | null;
  /** The signal strength in dBm: from a scan or `readRSSI`, else null. */
  rssi: number | null;
  /** The ATT MTU (23 until negotiated). */
  mtu: number;
  /** From a scan: the manufacturer data as advertised, company id first. */
  manufacturerData: Base64 | null;
  /** From a scan on Android: the raw advertisement; empty otherwise. */
  rawScanRecord: Base64;
  /** From a scan: service data by UUID. */
  serviceData: { [uuid: string]: Base64 } | null;
  /** From a scan, the advertised services; after discovery, the discovered ones. */
  serviceUUIDs: UUID[] | null;
  /** From a scan: the advertised name. */
  localName: string | null;
  /** From a scan: the advertised TX power, in dBm. */
  txPowerLevel: number | null;
  /** Always null: expo-ble-kit doesn't report solicited services. */
  solicitedServiceUUIDs: UUID[] | null;
  /** From a scan: whether it accepts connections. */
  isConnectable: boolean | null;
  /** Always null: expo-ble-kit doesn't report the overflow area. */
  overflowServiceUUIDs: UUID[] | null;
}

/** A service's fields, as `Service` carries them. */
export interface NativeService {
  /** Its number, stable for the device. */
  id: Identifier;
  /** Its UUID. */
  uuid: UUID;
  /** The device it belongs to. */
  deviceID: DeviceId;
  /** False for a secondary service. */
  isPrimary: boolean;
}

/** A characteristic's fields, as `Characteristic` carries them. */
export interface NativeCharacteristic {
  /** Its number, stable for the device. */
  id: Identifier;
  /** Its UUID. */
  uuid: UUID;
  /** Its service's number. */
  serviceID: Identifier;
  /** Its service's UUID. */
  serviceUUID: UUID;
  /** The device it belongs to. */
  deviceID: DeviceId;
  /** Whether it can be read. */
  isReadable: boolean;
  /** Whether it can be written with a response. */
  isWritableWithResponse: boolean;
  /** Whether it can be written without a response. */
  isWritableWithoutResponse: boolean;
  /** Whether it can notify. */
  isNotifiable: boolean;
  /** Whether this manager monitors it. */
  isNotifying: boolean;
  /** Whether it can indicate. */
  isIndicatable: boolean;
  /** The value the call read, wrote or received; null otherwise. */
  value: Base64 | null;
}

/** A descriptor's fields, as `Descriptor` carries them. */
export interface NativeDescriptor {
  /** Its number, stable for the device. */
  id: Identifier;
  /** Its UUID. */
  uuid: UUID;
  /** Its characteristic's number. */
  characteristicID: Identifier;
  /** Its characteristic's UUID. */
  characteristicUUID: UUID;
  /** Its service's number. */
  serviceID: Identifier;
  /** Its service's UUID. */
  serviceUUID: UUID;
  /** The device it belongs to. */
  deviceID: DeviceId;
  /** The value the call read or wrote; null otherwise. */
  value: Base64 | null;
}

/** 16-, 32- or 128-bit UUID to the lowercase 128-bit form, as ble-plx's `fullUUID`. */
export function fullUUID(uuid: UUID): UUID {
  if (uuid.length === 4) return `0000${uuid.toLowerCase()}-0000-1000-8000-00805f9b34fb`;
  if (uuid.length === 8) return `${uuid.toLowerCase()}-0000-1000-8000-00805f9b34fb`;
  return uuid.toLowerCase();
}
