import type { BleError } from './BleError';
import type { BleManager } from './BleManager';
import type { Characteristic } from './Characteristic';
import type { Descriptor } from './Descriptor';
import type {
  Base64,
  CharacteristicSubscriptionType,
  DeviceId,
  Identifier,
  NativeService,
  Subscription,
  TransactionId,
  UUID,
} from './TypeDefinition';

/** ble-plx's `Service`. Its methods address characteristics by UUID (the first instance). */
export class Service implements NativeService {
  id: Identifier;
  uuid: UUID;
  deviceID: DeviceId;
  isPrimary: boolean;
  /** @internal */
  _manager: BleManager;

  constructor(nativeService: NativeService, manager: BleManager) {
    this.id = nativeService.id;
    this.uuid = nativeService.uuid;
    this.deviceID = nativeService.deviceID;
    this.isPrimary = nativeService.isPrimary;
    this._manager = manager;
  }

  /** Its characteristics. */
  characteristics(): Promise<Characteristic[]> {
    return this._manager.characteristicsForDevice(this.deviceID, this.uuid);
  }

  /** A characteristic's descriptors. */
  descriptorsForCharacteristic(characteristicUUID: UUID): Promise<Descriptor[]> {
    return this._manager.descriptorsForDevice(this.deviceID, this.uuid, characteristicUUID);
  }

  /** Reads one of its characteristics. */
  readCharacteristic(
    characteristicUUID: UUID,
    transactionId?: TransactionId
  ): Promise<Characteristic> {
    return this._manager.readCharacteristicForDevice(
      this.deviceID,
      this.uuid,
      characteristicUUID,
      transactionId
    );
  }

  /** Writes one of its characteristics and waits for the acknowledgement. */
  writeCharacteristicWithResponse(
    characteristicUUID: UUID,
    valueBase64: Base64,
    transactionId?: TransactionId
  ): Promise<Characteristic> {
    return this._manager.writeCharacteristicWithResponseForDevice(
      this.deviceID,
      this.uuid,
      characteristicUUID,
      valueBase64,
      transactionId
    );
  }

  /** Writes one of its characteristics without a response. */
  writeCharacteristicWithoutResponse(
    characteristicUUID: UUID,
    valueBase64: Base64,
    transactionId?: TransactionId
  ): Promise<Characteristic> {
    return this._manager.writeCharacteristicWithoutResponseForDevice(
      this.deviceID,
      this.uuid,
      characteristicUUID,
      valueBase64,
      transactionId
    );
  }

  /** Monitors one of its characteristics. */
  monitorCharacteristic(
    characteristicUUID: UUID,
    listener: (error: BleError | null, characteristic: Characteristic | null) => void,
    transactionId?: TransactionId,
    subscriptionType?: CharacteristicSubscriptionType
  ): Subscription {
    return this._manager.monitorCharacteristicForDevice(
      this.deviceID,
      this.uuid,
      characteristicUUID,
      listener,
      transactionId,
      subscriptionType
    );
  }

  /** Reads a characteristic's descriptor. */
  readDescriptorForCharacteristic(
    characteristicUUID: UUID,
    descriptorUUID: UUID,
    transactionId?: TransactionId
  ): Promise<Descriptor> {
    return this._manager.readDescriptorForDevice(
      this.deviceID,
      this.uuid,
      characteristicUUID,
      descriptorUUID,
      transactionId
    );
  }

  /** Writes a characteristic's descriptor. */
  writeDescriptorForCharacteristic(
    characteristicUUID: UUID,
    descriptorUUID: UUID,
    valueBase64: Base64,
    transactionId?: TransactionId
  ): Promise<Descriptor> {
    return this._manager.writeDescriptorForDevice(
      this.deviceID,
      this.uuid,
      characteristicUUID,
      descriptorUUID,
      valueBase64,
      transactionId
    );
  }
}
