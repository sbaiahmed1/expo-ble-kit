import type { BleError } from './BleError';
import type { BleManager } from './BleManager';
import type { Characteristic } from './Characteristic';
import type { Descriptor } from './Descriptor';
import type { Service } from './Service';
import type {
  Base64,
  CharacteristicSubscriptionType,
  ConnectionOptions,
  ConnectionPriority,
  DeviceId,
  NativeDevice,
  Subscription,
  TransactionId,
  UUID,
} from './TypeDefinition';

/**
 * ble-plx's `Device`: a snapshot of what was known when the call answered (advertisement fields
 * from a scan), with methods that act through its manager.
 */
export class Device implements NativeDevice {
  id: DeviceId;
  name: string | null;
  rssi: number | null;
  mtu: number;
  manufacturerData: Base64 | null;
  rawScanRecord: Base64;
  serviceData: { [uuid: string]: Base64 } | null;
  serviceUUIDs: UUID[] | null;
  localName: string | null;
  txPowerLevel: number | null;
  solicitedServiceUUIDs: UUID[] | null;
  isConnectable: boolean | null;
  overflowServiceUUIDs: UUID[] | null;
  /** @internal */
  _manager: BleManager;

  constructor(nativeDevice: NativeDevice, manager: BleManager) {
    this.id = nativeDevice.id;
    this.name = nativeDevice.name;
    this.rssi = nativeDevice.rssi;
    this.mtu = nativeDevice.mtu;
    this.manufacturerData = nativeDevice.manufacturerData;
    this.rawScanRecord = nativeDevice.rawScanRecord;
    this.serviceData = nativeDevice.serviceData;
    this.serviceUUIDs = nativeDevice.serviceUUIDs;
    this.localName = nativeDevice.localName;
    this.txPowerLevel = nativeDevice.txPowerLevel;
    this.solicitedServiceUUIDs = nativeDevice.solicitedServiceUUIDs;
    this.isConnectable = nativeDevice.isConnectable;
    this.overflowServiceUUIDs = nativeDevice.overflowServiceUUIDs;
    this._manager = manager;
  }

  /** Android: asks for a connection interval. iOS answers at once. */
  requestConnectionPriority(
    connectionPriority: ConnectionPriority,
    transactionId?: TransactionId
  ): Promise<Device> {
    return this._manager.requestConnectionPriorityForDevice(
      this.id,
      connectionPriority,
      transactionId
    );
  }

  /** Reads the signal strength; resolves the device with `rssi` set. */
  readRSSI(transactionId?: TransactionId): Promise<Device> {
    return this._manager.readRSSIForDevice(this.id, transactionId);
  }

  /** Android negotiates the MTU; iOS resolves the one it chose. */
  requestMTU(mtu: number, transactionId?: TransactionId): Promise<Device> {
    return this._manager.requestMTUForDevice(this.id, mtu, transactionId);
  }

  /** Connects, without discovering: call `discoverAllServicesAndCharacteristics` next. */
  connect(options?: ConnectionOptions): Promise<Device> {
    return this._manager.connectToDevice(this.id, options);
  }

  /** Disconnects, or cancels a pending connect. */
  cancelConnection(): Promise<Device> {
    return this._manager.cancelDeviceConnection(this.id);
  }

  /** Whether it is connected. */
  isConnected(): Promise<boolean> {
    return this._manager.isDeviceConnected(this.id);
  }

  /** Calls `listener` when it disconnects: with an error unless the app asked. */
  onDisconnected(listener: (error: BleError | null, device: Device) => void): Subscription {
    return this._manager.onDeviceDisconnected(this.id, listener);
  }

  /** Discovers every service, characteristic and descriptor. */
  discoverAllServicesAndCharacteristics(transactionId?: TransactionId): Promise<Device> {
    return this._manager.discoverAllServicesAndCharacteristicsForDevice(this.id, transactionId);
  }

  /** The discovered services. */
  services(): Promise<Service[]> {
    return this._manager.servicesForDevice(this.id);
  }

  /** A discovered service's characteristics. */
  characteristicsForService(serviceUUID: UUID): Promise<Characteristic[]> {
    return this._manager.characteristicsForDevice(this.id, serviceUUID);
  }

  /** A discovered characteristic's descriptors. */
  descriptorsForService(serviceUUID: UUID, characteristicUUID: UUID): Promise<Descriptor[]> {
    return this._manager.descriptorsForDevice(this.id, serviceUUID, characteristicUUID);
  }

  /** Reads a characteristic; its `value` is base64. */
  readCharacteristicForService(
    serviceUUID: UUID,
    characteristicUUID: UUID,
    transactionId?: TransactionId
  ): Promise<Characteristic> {
    return this._manager.readCharacteristicForDevice(
      this.id,
      serviceUUID,
      characteristicUUID,
      transactionId
    );
  }

  /** Writes a base64 value and waits for the acknowledgement. */
  writeCharacteristicWithResponseForService(
    serviceUUID: UUID,
    characteristicUUID: UUID,
    valueBase64: Base64,
    transactionId?: TransactionId
  ): Promise<Characteristic> {
    return this._manager.writeCharacteristicWithResponseForDevice(
      this.id,
      serviceUUID,
      characteristicUUID,
      valueBase64,
      transactionId
    );
  }

  /** Writes a base64 value without a response. */
  writeCharacteristicWithoutResponseForService(
    serviceUUID: UUID,
    characteristicUUID: UUID,
    valueBase64: Base64,
    transactionId?: TransactionId
  ): Promise<Characteristic> {
    return this._manager.writeCharacteristicWithoutResponseForDevice(
      this.id,
      serviceUUID,
      characteristicUUID,
      valueBase64,
      transactionId
    );
  }

  /** Calls `listener` with each notification or indication; `remove()` ends it with OperationCancelled. */
  monitorCharacteristicForService(
    serviceUUID: UUID,
    characteristicUUID: UUID,
    listener: (error: BleError | null, characteristic: Characteristic | null) => void,
    transactionId?: TransactionId,
    subscriptionType?: CharacteristicSubscriptionType
  ): Subscription {
    return this._manager.monitorCharacteristicForDevice(
      this.id,
      serviceUUID,
      characteristicUUID,
      listener,
      transactionId,
      subscriptionType
    );
  }

  /** Reads a descriptor; its `value` is base64. */
  readDescriptorForService(
    serviceUUID: UUID,
    characteristicUUID: UUID,
    descriptorUUID: UUID,
    transactionId?: TransactionId
  ): Promise<Descriptor> {
    return this._manager.readDescriptorForDevice(
      this.id,
      serviceUUID,
      characteristicUUID,
      descriptorUUID,
      transactionId
    );
  }

  /** Writes a base64 value to a descriptor (not the CCCD). */
  writeDescriptorForService(
    serviceUUID: UUID,
    characteristicUUID: UUID,
    descriptorUUID: UUID,
    valueBase64: Base64,
    transactionId?: TransactionId
  ): Promise<Descriptor> {
    return this._manager.writeDescriptorForDevice(
      this.id,
      serviceUUID,
      characteristicUUID,
      descriptorUUID,
      valueBase64,
      transactionId
    );
  }
}
