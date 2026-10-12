// The parts of the Web Bluetooth API (https://webbluetoothcg.github.io/web-bluetooth/) the web
// adapter uses. TypeScript's DOM library doesn't declare them, and the package adds no dependency
// for types.

export interface WebBluetooth extends EventTarget {
  getAvailability(): Promise<boolean>;
  requestDevice(options: RequestDeviceOptions): Promise<WebBluetoothDevice>;
  /** Devices the site was allowed earlier; Chrome only, and not everywhere. */
  getDevices?(): Promise<WebBluetoothDevice[]>;
}

export interface RequestDeviceOptions {
  filters?: WebScanFilter[];
  acceptAllDevices?: boolean;
  optionalServices?: string[];
}

export interface WebScanFilter {
  services?: string[];
  namePrefix?: string;
  manufacturerData?: { companyIdentifier: number; dataPrefix?: Uint8Array; mask?: Uint8Array }[];
}

export interface WebBluetoothDevice extends EventTarget {
  readonly id: string;
  readonly name?: string;
  readonly gatt?: WebGattServer;
}

export interface WebGattServer {
  readonly connected: boolean;
  connect(): Promise<WebGattServer>;
  disconnect(): void;
  getPrimaryServices(service?: string): Promise<WebGattService[]>;
}

export interface WebGattService {
  readonly uuid: string;
  readonly isPrimary: boolean;
  getCharacteristics(): Promise<WebGattCharacteristic[]>;
}

export interface WebCharacteristicProperties {
  readonly broadcast: boolean;
  readonly read: boolean;
  readonly writeWithoutResponse: boolean;
  readonly write: boolean;
  readonly notify: boolean;
  readonly indicate: boolean;
  readonly authenticatedSignedWrites: boolean;
  readonly reliableWrite: boolean;
  readonly writableAuxiliaries: boolean;
}

export interface WebGattCharacteristic extends EventTarget {
  readonly uuid: string;
  readonly properties: WebCharacteristicProperties;
  readonly value?: DataView | null;
  readValue(): Promise<DataView>;
  writeValue(value: Uint8Array): Promise<void>;
  writeValueWithResponse?(value: Uint8Array): Promise<void>;
  writeValueWithoutResponse?(value: Uint8Array): Promise<void>;
  startNotifications(): Promise<WebGattCharacteristic>;
  stopNotifications(): Promise<WebGattCharacteristic>;
  getDescriptors(): Promise<WebGattDescriptor[]>;
}

export interface WebGattDescriptor {
  readonly uuid: string;
  readValue(): Promise<DataView>;
  writeValue(value: Uint8Array): Promise<void>;
}

/** `navigator.bluetooth`, or null where the browser has none (Firefox, Safari, insecure pages). */
export function webBluetooth(): WebBluetooth | null {
  const navigator = (globalThis as { navigator?: { bluetooth?: WebBluetooth } }).navigator;
  return navigator?.bluetooth ?? null;
}
