import type { BleError } from './BleError';
import type { BleManager } from './BleManager';
import type { Descriptor } from './Descriptor';
import type {
  Base64,
  CharacteristicSubscriptionType,
  DeviceId,
  Identifier,
  NativeCharacteristic,
  Subscription,
  TransactionId,
  UUID,
} from './TypeDefinition';

/** ble-plx's `Characteristic`: its properties, and `value` (base64) from the call that returned it. */
export class Characteristic implements NativeCharacteristic {
  id: Identifier;
  uuid: UUID;
  serviceID: Identifier;
  serviceUUID: UUID;
  deviceID: DeviceId;
  isReadable: boolean;
  isWritableWithResponse: boolean;
  isWritableWithoutResponse: boolean;
  isNotifiable: boolean;
  isNotifying: boolean;
  isIndicatable: boolean;
  value: Base64 | null;
  /** @internal */
  _manager: BleManager;

  constructor(nativeCharacteristic: NativeCharacteristic, manager: BleManager) {
    this.id = nativeCharacteristic.id;
    this.uuid = nativeCharacteristic.uuid;
    this.serviceID = nativeCharacteristic.serviceID;
    this.serviceUUID = nativeCharacteristic.serviceUUID;
    this.deviceID = nativeCharacteristic.deviceID;
    this.isReadable = nativeCharacteristic.isReadable;
    this.isWritableWithResponse = nativeCharacteristic.isWritableWithResponse;
    this.isWritableWithoutResponse = nativeCharacteristic.isWritableWithoutResponse;
    this.isNotifiable = nativeCharacteristic.isNotifiable;
    this.isNotifying = nativeCharacteristic.isNotifying;
    this.isIndicatable = nativeCharacteristic.isIndicatable;
    this.value = nativeCharacteristic.value;
    this._manager = manager;
  }

  /** Its descriptors. */
  descriptors(): Promise<Descriptor[]> {
    return this._manager.descriptorsForDevice(this.deviceID, this.serviceUUID, this.uuid);
  }

  /** Reads it again; the result carries the value. */
  read(transactionId?: TransactionId): Promise<Characteristic> {
    return this._manager.readCharacteristicForDevice(
      this.deviceID,
      this.serviceUUID,
      this.uuid,
      transactionId
    );
  }

  /** Writes a base64 value and waits for the acknowledgement. */
  writeWithResponse(valueBase64: Base64, transactionId?: TransactionId): Promise<Characteristic> {
    return this._manager.writeCharacteristicWithResponseForDevice(
      this.deviceID,
      this.serviceUUID,
      this.uuid,
      valueBase64,
      transactionId
    );
  }

  /** Writes a base64 value without a response. */
  writeWithoutResponse(
    valueBase64: Base64,
    transactionId?: TransactionId
  ): Promise<Characteristic> {
    return this._manager.writeCharacteristicWithoutResponseForDevice(
      this.deviceID,
      this.serviceUUID,
      this.uuid,
      valueBase64,
      transactionId
    );
  }

  /** Calls `listener` with each notification or indication. */
  monitor(
    listener: (error: BleError | null, characteristic: Characteristic | null) => void,
    transactionId?: TransactionId,
    subscriptionType?: CharacteristicSubscriptionType
  ): Subscription {
    return this._manager.monitorCharacteristicForDevice(
      this.deviceID,
      this.serviceUUID,
      this.uuid,
      listener,
      transactionId,
      subscriptionType
    );
  }

  /** Reads one of its descriptors. */
  readDescriptor(descriptorUUID: UUID, transactionId?: TransactionId): Promise<Descriptor> {
    return this._manager.readDescriptorForDevice(
      this.deviceID,
      this.serviceUUID,
      this.uuid,
      descriptorUUID,
      transactionId
    );
  }

  /** Writes one of its descriptors. */
  writeDescriptor(
    descriptorUUID: UUID,
    valueBase64: Base64,
    transactionId?: TransactionId
  ): Promise<Descriptor> {
    return this._manager.writeDescriptorForDevice(
      this.deviceID,
      this.serviceUUID,
      this.uuid,
      descriptorUUID,
      valueBase64,
      transactionId
    );
  }
}
