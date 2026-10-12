import type { BleManager } from './BleManager';
import type {
  Base64,
  DeviceId,
  Identifier,
  NativeDescriptor,
  TransactionId,
  UUID,
} from './TypeDefinition';

/** ble-plx's `Descriptor`, with `value` (base64) from the call that returned it. */
export class Descriptor implements NativeDescriptor {
  id: Identifier;
  uuid: UUID;
  characteristicID: Identifier;
  characteristicUUID: UUID;
  serviceID: Identifier;
  serviceUUID: UUID;
  deviceID: DeviceId;
  value: Base64 | null;
  /** @internal */
  _manager: BleManager;

  constructor(nativeDescriptor: NativeDescriptor, manager: BleManager) {
    this.id = nativeDescriptor.id;
    this.uuid = nativeDescriptor.uuid;
    this.characteristicID = nativeDescriptor.characteristicID;
    this.characteristicUUID = nativeDescriptor.characteristicUUID;
    this.serviceID = nativeDescriptor.serviceID;
    this.serviceUUID = nativeDescriptor.serviceUUID;
    this.deviceID = nativeDescriptor.deviceID;
    this.value = nativeDescriptor.value;
    this._manager = manager;
  }

  /** Reads it; the result carries the value. */
  read(transactionId?: TransactionId): Promise<Descriptor> {
    return this._manager.readDescriptorForDevice(
      this.deviceID,
      this.serviceUUID,
      this.characteristicUUID,
      this.uuid,
      transactionId
    );
  }

  /** Writes a base64 value. */
  write(valueBase64: Base64, transactionId?: TransactionId): Promise<Descriptor> {
    return this._manager.writeDescriptorForDevice(
      this.deviceID,
      this.serviceUUID,
      this.characteristicUUID,
      this.uuid,
      valueBase64,
      transactionId
    );
  }
}
