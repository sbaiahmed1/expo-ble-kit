import { Platform } from 'react-native';

import {
  BleError,
  BleErrorCode,
  BleErrorCodeMessage,
  plxError,
  toPlxError,
  type BleErrorCodeMessageMapping,
  type ErrorContext,
} from './BleError';
import { Characteristic } from './Characteristic';
import { Descriptor } from './Descriptor';
import { Device } from './Device';
import { Service } from './Service';
import {
  LogLevel,
  State,
  type Base64,
  type BleManagerOptions,
  type CharacteristicSubscriptionType,
  type ConnectionOptions,
  type ConnectionPriority,
  type DeviceId,
  type NativeDevice,
  type ScanOptions,
  type Subscription,
  type TransactionId,
  type UUID,
} from './TypeDefinition';
import { fromBase64, toBase64 } from './base64';
import { BleManager as Kit } from '../../BleManager';
import type {
  BleState,
  CharacteristicSubscription,
  Characteristic as KitCharacteristic,
  LogLevel as KitLogLevel,
  Peripheral,
  ScanOptions as KitScanOptions,
  ScanResult,
  ScanSession,
} from '../../types';
import { normalizeUUID } from '../../uuid';

// ble-plx's BleManager (react-native-ble-plx 3.5.1) over expo-ble-kit's public API (plan §7 P6-01).
// The differences from ble-plx are listed in docs/guides/migration-from-plx.md.

const STATES: Record<BleState, State> = {
  unknown: State.Unknown,
  resetting: State.Resetting,
  unsupported: State.Unsupported,
  unauthorized: State.Unauthorized,
  poweredOff: State.PoweredOff,
  poweredOn: State.PoweredOn,
};

const LOG_LEVELS: Record<LogLevel, KitLogLevel> = {
  None: 'none',
  Verbose: 'verbose',
  Debug: 'debug',
  Info: 'info',
  Warning: 'warn',
  Error: 'error',
};

const SCAN_MODES = {
  [-1]: 'opportunistic',
  0: 'lowPower',
  1: 'balanced',
  2: 'lowLatency',
} as const;
const CALLBACK_TYPES = { 1: 'allMatches', 2: 'firstMatch', 4: 'matchLost' } as const;
const PRIORITIES = { 0: 'balanced', 1: 'high', 2: 'lowPower' } as const;
const CCCD = '00002902-0000-1000-8000-00805f9b34fb';

/** A UUID as ble-plx reports it: lowercase 128-bit, left as given when it isn't one. */
function uuidOf(uuid: string): string {
  try {
    return normalizeUUID(uuid);
  } catch {
    return String(uuid).toLowerCase();
  }
}

type Monitor = { end: (error: BleError | null) => void };

/**
 * ble-plx's manager: one shared instance (`new BleManager()` returns it until `destroy()`), values
 * as base64, operations cancellable by transaction id. On iOS, creating it asks for Bluetooth
 * permission, as ble-plx's native client does.
 */
export class BleManager {
  /** The instance `new BleManager()` returns until it is destroyed. */
  static sharedInstance: BleManager | null = null;

  private messages: BleErrorCodeMessageMapping = BleErrorCodeMessage;
  private level: LogLevel = LogLevel.Warning;
  private destroyed = false;
  private scan: ScanSession | null = null;
  /** Rejections of the calls in flight, for `destroy()`. */
  private readonly pending = new Map<number, (error: BleError) => void>();
  private readonly transactions = new Map<TransactionId, () => void>();
  private readonly monitors = new Map<TransactionId, Monitor>();
  /** Active monitors per characteristic, for `isNotifying`. */
  private readonly notifying = new Map<string, number>();
  private readonly subscriptions = new Set<Subscription>();
  /** Devices connected through this manager: `destroy()` disconnects them. */
  private readonly connected = new Set<DeviceId>();
  private readonly identifiers = new Map<string, number>();
  private nextCall = 0;
  private nextTransaction = 0;

  constructor(options: BleManagerOptions = {}) {
    if (BleManager.sharedInstance) return BleManager.sharedInstance;
    if (options.errorCodesToMessagesMapping) this.messages = options.errorCodesToMessagesMapping;
    const restore = options.restoreStateFunction;
    if (options.restoreStateIdentifier != null && restore) {
      // iOS state restoration isn't available yet: nothing is ever restored.
      Promise.resolve().then(() => restore(null));
    }
    if (Platform.OS === 'ios') Kit.requestPermissionsAsync().catch(() => {});
    BleManager.sharedInstance = this;
  }

  /** Ends every monitor, scan and listener, rejects the calls in flight, and disconnects. */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    if (BleManager.sharedInstance === this) BleManager.sharedInstance = null;
    this.stopScan();
    [...this.subscriptions].forEach((subscription) => subscription.remove());
    const destroyed = this.error(BleErrorCode.BluetoothManagerDestroyed, {});
    [...this.monitors.values()].forEach((monitor) => monitor.end(destroyed));
    [...this.pending.values()].forEach((reject) => reject(destroyed));
    [...this.transactions.values()].forEach((cancel) => cancel());
    this.transactions.clear();
    const ids = [...this.connected];
    this.connected.clear();
    await Promise.all(
      ids.map((id) =>
        Kit.getPeripheral(id)
          .disconnect()
          .catch(() => {})
      )
    );
  }

  /** Sets how much the native side logs; resolves the new level. */
  async setLogLevel(logLevel: LogLevel): Promise<LogLevel> {
    const level = LOG_LEVELS[logLevel];
    if (!level) throw this.error(BleErrorCode.UnknownError, {}, `Invalid log level: ${logLevel}`);
    Kit.setLogLevel(level);
    this.level = logLevel;
    return logLevel;
  }

  /** The level `setLogLevel` set (expo-ble-kit starts at Warning). */
  async logLevel(): Promise<LogLevel> {
    return this.level;
  }

  /** Cancels the call or monitor started with `transactionId`; it fails with OperationCancelled. */
  async cancelTransaction(transactionId: TransactionId): Promise<void> {
    this.cancel(transactionId);
  }

  /** Not available: apps can't turn Bluetooth on (Android 13+ forbids it). Rejects. */
  enable(transactionId?: TransactionId): Promise<BleManager> {
    return this.call({ kind: 'other' }, transactionId, async () => {
      throw this.error(
        BleErrorCode.BluetoothStateChangeFailed,
        {},
        "expo-ble-kit doesn't turn Bluetooth on: ask the user to"
      );
    });
  }

  /** Not available: apps can't turn Bluetooth off. Rejects. */
  disable(transactionId?: TransactionId): Promise<BleManager> {
    return this.call({ kind: 'other' }, transactionId, async () => {
      throw this.error(
        BleErrorCode.BluetoothStateChangeFailed,
        {},
        "expo-ble-kit doesn't turn Bluetooth off"
      );
    });
  }

  /** Bluetooth's state. */
  state(): Promise<State> {
    return this.call({ kind: 'other' }, null, async () => STATES[Kit.state]);
  }

  /** Calls `listener` on each state change, and with the current state first when `emitCurrentState`. */
  onStateChange(listener: (newState: State) => void, emitCurrentState = false): Subscription {
    let removed = false;
    const subscription = Kit.addStateListener((state) => listener(STATES[state]));
    if (emitCurrentState) {
      Promise.resolve().then(() => {
        if (!removed) listener(STATES[Kit.state]);
      });
    }
    return this.track(() => {
      removed = true;
      subscription.remove();
    });
  }

  // Scanning

  /** One scan at a time: a new one replaces the running one. Errors go to `listener`. */
  startDeviceScan(
    UUIDs: UUID[] | null,
    options: ScanOptions | null,
    listener: (error: BleError | null, scannedDevice: Device | null) => void
  ): Promise<void> {
    return this.call({ kind: 'scan' }, null, async () => {
      this.stopScan();
      const android: NonNullable<KitScanOptions['android']> = {};
      if (options?.scanMode !== undefined) android.scanMode = SCAN_MODES[options.scanMode];
      if (options?.callbackType !== undefined) {
        android.callbackType = CALLBACK_TYPES[options.callbackType];
      }
      if (options?.legacyScan !== undefined) android.legacy = options.legacyScan;
      const session = Kit.startScan(
        {
          services: UUIDs ?? [],
          // Android delivers every advertisement in ble-plx; iOS only with allowDuplicates.
          allowDuplicates: Platform.OS === 'android' || (options?.allowDuplicates ?? false),
          android,
        },
        (results) => results.forEach((result) => listener(null, this.scanned(result))),
        (error) => {
          if (this.scan === session) this.scan = null;
          listener(toPlxError(error, { kind: 'scan' }, this.messages), null);
        }
      );
      this.scan = session;
    });
  }

  /** Stops the scan `startDeviceScan` started. */
  async stopDeviceScan(): Promise<void> {
    this.stopScan();
  }

  // Connections

  /** Android only, as in ble-plx; iOS answers at once. */
  requestConnectionPriorityForDevice(
    deviceIdentifier: DeviceId,
    connectionPriority: ConnectionPriority,
    transactionId?: TransactionId
  ): Promise<Device> {
    const peripheral = Kit.getPeripheral(deviceIdentifier);
    return this.call({ kind: 'other', deviceID: deviceIdentifier }, transactionId, async () => {
      if (Platform.OS === 'android') {
        this.requireConnected(peripheral);
        await peripheral.android.requestConnectionPriority(PRIORITIES[connectionPriority]);
      }
      return this.device(peripheral);
    });
  }

  /** Reads the connection's signal strength; resolves the device with `rssi` set. */
  readRSSIForDevice(deviceIdentifier: DeviceId, transactionId?: TransactionId): Promise<Device> {
    const peripheral = Kit.getPeripheral(deviceIdentifier);
    return this.call(
      { kind: 'rssi', deviceID: deviceIdentifier },
      transactionId,
      async (signal) => {
        this.requireConnected(peripheral);
        const rssi = await peripheral.readRssi({ signal });
        return this.device(peripheral, { rssi });
      }
    );
  }

  /** Android negotiates; iOS answers with the MTU it chose. */
  requestMTUForDevice(
    deviceIdentifier: DeviceId,
    mtu: number,
    transactionId?: TransactionId
  ): Promise<Device> {
    const peripheral = Kit.getPeripheral(deviceIdentifier);
    return this.call({ kind: 'mtu', deviceID: deviceIdentifier }, transactionId, async (signal) => {
      this.requireConnected(peripheral);
      const agreed = await peripheral.requestMtu(mtu, { signal });
      return this.device(peripheral, { mtu: agreed });
    });
  }

  /** The devices the system knows among `deviceIdentifiers` (iOS leaves out unknown ones). */
  devices(deviceIdentifiers: DeviceId[]): Promise<Device[]> {
    return this.call({ kind: 'other' }, null, async () =>
      (await Kit.getKnownPeripherals(deviceIdentifiers)).map((peripheral) =>
        this.device(peripheral)
      )
    );
  }

  /** Devices connected at the system level (Android doesn't filter by service). */
  connectedDevices(serviceUUIDs: UUID[]): Promise<Device[]> {
    return this.call({ kind: 'other' }, null, async () =>
      (await Kit.getSystemConnectedPeripherals(serviceUUIDs)).map((peripheral) =>
        this.device(peripheral)
      )
    );
  }

  /**
   * Connects without discovering, as ble-plx does: call `discoverAllServicesAndCharacteristics`
   * next. Without `timeout`, expo-ble-kit's default (15 s) applies, except with `autoConnect`.
   */
  connectToDevice(deviceIdentifier: DeviceId, options?: ConnectionOptions): Promise<Device> {
    const peripheral = Kit.getPeripheral(deviceIdentifier);
    return this.call({ kind: 'connect', deviceID: deviceIdentifier }, null, async () => {
      const autoConnect = options?.autoConnect;
      const android: { autoConnect?: boolean; requestMtu?: number } = {};
      if (autoConnect !== undefined) android.autoConnect = autoConnect;
      if (options?.requestMTU !== undefined) android.requestMtu = options.requestMTU;
      await peripheral.connect({
        timeoutMs: options?.timeout ?? (autoConnect ? null : undefined),
        autoDiscover: false,
        android,
      });
      this.connected.add(peripheral.id);
      if (options?.refreshGatt === 'OnConnected' && Platform.OS === 'android') {
        await peripheral.android.refreshGattCache();
      }
      return this.device(peripheral);
    });
  }

  /** Disconnects, or cancels a pending connect. */
  cancelDeviceConnection(deviceIdentifier: DeviceId): Promise<Device> {
    const peripheral = Kit.getPeripheral(deviceIdentifier);
    return this.call({ kind: 'connect', deviceID: deviceIdentifier }, null, async () => {
      await peripheral.disconnect();
      this.connected.delete(peripheral.id);
      return this.device(peripheral);
    });
  }

  /** `error` is null when the app disconnected, DeviceDisconnected (or why) otherwise. */
  onDeviceDisconnected(
    deviceIdentifier: DeviceId,
    listener: (error: BleError | null, device: Device) => void
  ): Subscription {
    const peripheral = Kit.getPeripheral(deviceIdentifier);
    const subscription = peripheral.addConnectionStateListener((state, error) => {
      if (state !== 'disconnected') return;
      const context: ErrorContext = { kind: 'connect', deviceID: deviceIdentifier };
      listener(error ? toPlxError(error, context, this.messages) : null, this.device(peripheral));
    });
    return this.track(() => subscription.remove());
  }

  /** Whether the device is connected. */
  isDeviceConnected(deviceIdentifier: DeviceId): Promise<boolean> {
    const peripheral = Kit.getPeripheral(deviceIdentifier);
    return this.call({ kind: 'other' }, null, async () => peripheral.state === 'connected');
  }

  // Discovery

  /** Discovers every service, characteristic and descriptor; resolves the device with `serviceUUIDs` set. */
  discoverAllServicesAndCharacteristicsForDevice(
    deviceIdentifier: DeviceId,
    transactionId?: TransactionId
  ): Promise<Device> {
    const peripheral = Kit.getPeripheral(deviceIdentifier);
    return this.call(
      { kind: 'discover', deviceID: deviceIdentifier },
      transactionId,
      async (signal) => {
        this.requireConnected(peripheral);
        const services = await peripheral.discover(undefined, { signal });
        return this.device(peripheral, { serviceUUIDs: services.map((service) => service.uuid) });
      }
    );
  }

  /** The discovered services. */
  servicesForDevice(deviceIdentifier: DeviceId): Promise<Service[]> {
    const peripheral = Kit.getPeripheral(deviceIdentifier);
    const context: ErrorContext = { kind: 'other', deviceID: deviceIdentifier };
    return this.call(context, null, async () => {
      this.requireConnected(peripheral);
      if (peripheral.services.length === 0)
        throw this.error(BleErrorCode.ServicesNotDiscovered, context);
      return peripheral.services.map(
        (service) =>
          new Service(
            {
              id: this.identifier(peripheral.id, service.uuid),
              uuid: service.uuid,
              deviceID: peripheral.id,
              isPrimary: service.isPrimary,
            },
            this
          )
      );
    });
  }

  /** The characteristics of a discovered service. */
  characteristicsForDevice(
    deviceIdentifier: DeviceId,
    serviceUUID: UUID
  ): Promise<Characteristic[]> {
    const peripheral = Kit.getPeripheral(deviceIdentifier);
    const context: ErrorContext = { kind: 'other', deviceID: deviceIdentifier, serviceUUID };
    return this.call(context, null, async () => {
      this.requireConnected(peripheral);
      const service = peripheral.services.find(
        (candidate) => candidate.uuid === uuidOf(serviceUUID)
      );
      if (!service) throw this.error(BleErrorCode.ServiceNotFound, context);
      return service.characteristics.map((characteristic) =>
        this.characteristic(peripheral.id, characteristic.serviceUUID, characteristic.uuid, null)
      );
    });
  }

  /** The descriptors of a discovered characteristic. */
  descriptorsForDevice(
    deviceIdentifier: DeviceId,
    serviceUUID: UUID,
    characteristicUUID: UUID
  ): Promise<Descriptor[]> {
    const peripheral = Kit.getPeripheral(deviceIdentifier);
    const context: ErrorContext = {
      kind: 'other',
      deviceID: deviceIdentifier,
      serviceUUID,
      characteristicUUID,
    };
    return this.call(context, null, async () => {
      this.requireConnected(peripheral);
      const characteristic = this.find(peripheral, serviceUUID, characteristicUUID);
      if (!characteristic) throw this.error(BleErrorCode.CharacteristicNotFound, context);
      return characteristic.descriptors.map((descriptor) =>
        this.descriptor(
          peripheral.id,
          characteristic.serviceUUID,
          characteristic.uuid,
          descriptor.uuid,
          null
        )
      );
    });
  }

  // Characteristics

  /** Reads a characteristic; its `value` is base64. */
  readCharacteristicForDevice(
    deviceIdentifier: DeviceId,
    serviceUUID: UUID,
    characteristicUUID: UUID,
    transactionId?: TransactionId
  ): Promise<Characteristic> {
    const peripheral = Kit.getPeripheral(deviceIdentifier);
    const context: ErrorContext = {
      kind: 'read',
      deviceID: deviceIdentifier,
      serviceUUID,
      characteristicUUID,
    };
    return this.call(context, transactionId, async (signal) => {
      this.requireConnected(peripheral);
      const value = await peripheral.read(serviceUUID, characteristicUUID, { signal });
      return this.characteristic(
        peripheral.id,
        uuidOf(serviceUUID),
        uuidOf(characteristicUUID),
        toBase64(value)
      );
    });
  }

  /** Writes a base64 value and waits for the device to acknowledge it. */
  writeCharacteristicWithResponseForDevice(
    deviceIdentifier: DeviceId,
    serviceUUID: UUID,
    characteristicUUID: UUID,
    base64Value: Base64,
    transactionId?: TransactionId
  ): Promise<Characteristic> {
    return this.write(
      deviceIdentifier,
      serviceUUID,
      characteristicUUID,
      base64Value,
      true,
      transactionId
    );
  }

  /** Writes a base64 value without a response; it must fit one packet (MTU − 3). */
  writeCharacteristicWithoutResponseForDevice(
    deviceIdentifier: DeviceId,
    serviceUUID: UUID,
    characteristicUUID: UUID,
    base64Value: Base64,
    transactionId?: TransactionId
  ): Promise<Characteristic> {
    return this.write(
      deviceIdentifier,
      serviceUUID,
      characteristicUUID,
      base64Value,
      false,
      transactionId
    );
  }

  /**
   * Calls `listener` with each value. Removing the subscription, cancelling its transaction, a
   * disconnect or `destroy()` end it with an error, as in ble-plx (OperationCancelled,
   * DeviceDisconnected, BluetoothManagerDestroyed). iOS chooses notifications or indications by
   * itself, so `subscriptionType` only applies on Android.
   */
  monitorCharacteristicForDevice(
    deviceIdentifier: DeviceId,
    serviceUUID: UUID,
    characteristicUUID: UUID,
    listener: (error: BleError | null, characteristic: Characteristic | null) => void,
    transactionId?: TransactionId,
    subscriptionType?: CharacteristicSubscriptionType
  ): Subscription {
    const transaction = transactionId ?? `monitor-${++this.nextTransaction}`;
    this.cancel(transaction);
    const context: ErrorContext = {
      kind: 'monitor',
      deviceID: deviceIdentifier,
      serviceUUID,
      characteristicUUID,
    };
    const peripheral = Kit.getPeripheral(deviceIdentifier);
    const service = uuidOf(serviceUUID);
    const uuid = uuidOf(characteristicUUID);
    const key = `${peripheral.id}|${service}|${uuid}`;
    let ended = false;
    let counted = false;
    let subscription: CharacteristicSubscription | null = null;
    const end = (error: BleError | null) => {
      if (ended) return;
      ended = true;
      if (this.monitors.get(transaction) === monitor) this.monitors.delete(transaction);
      connection.remove();
      if (counted) this.notifying.set(key, (this.notifying.get(key) ?? 1) - 1);
      subscription?.unsubscribe().catch(() => {});
      if (error) Promise.resolve().then(() => listener(error, null));
    };
    const monitor: Monitor = { end };
    this.monitors.set(transaction, monitor);
    const connection = peripheral.addConnectionStateListener((state) => {
      if (state === 'disconnected') end(this.error(BleErrorCode.DeviceDisconnected, context));
    });
    (async () => {
      if (this.destroyed) throw this.error(BleErrorCode.BluetoothManagerDestroyed, context);
      this.requireConnected(peripheral);
      counted = true;
      this.notifying.set(key, (this.notifying.get(key) ?? 0) + 1);
      const mode =
        Platform.OS === 'ios' || !subscriptionType
          ? 'auto'
          : subscriptionType === 'indication'
            ? 'indicate'
            : 'notify';
      const active = await peripheral.subscribe(
        serviceUUID,
        characteristicUUID,
        (value) => {
          if (!ended)
            listener(null, this.characteristic(peripheral.id, service, uuid, toBase64(value)));
        },
        { mode }
      );
      if (ended) active.unsubscribe().catch(() => {});
      else subscription = active;
    })().catch((error) => end(toPlxError(error, context, this.messages)));
    return {
      remove: () => end(this.error(BleErrorCode.OperationCancelled, context)),
    };
  }

  // Descriptors

  /** Reads a descriptor; its `value` is base64. */
  readDescriptorForDevice(
    deviceIdentifier: DeviceId,
    serviceUUID: UUID,
    characteristicUUID: UUID,
    descriptorUUID: UUID,
    transactionId?: TransactionId
  ): Promise<Descriptor> {
    const peripheral = Kit.getPeripheral(deviceIdentifier);
    const context: ErrorContext = {
      kind: 'readDescriptor',
      deviceID: deviceIdentifier,
      serviceUUID,
      characteristicUUID,
      descriptorUUID,
    };
    return this.call(context, transactionId, async (signal) => {
      this.requireConnected(peripheral);
      const value = await peripheral.readDescriptor(
        serviceUUID,
        characteristicUUID,
        descriptorUUID,
        { signal }
      );
      return this.descriptor(
        peripheral.id,
        uuidOf(serviceUUID),
        uuidOf(characteristicUUID),
        uuidOf(descriptorUUID),
        toBase64(value)
      );
    });
  }

  /** The CCCD (0x2902) can't be written: monitor the characteristic instead, as in ble-plx. */
  writeDescriptorForDevice(
    deviceIdentifier: DeviceId,
    serviceUUID: UUID,
    characteristicUUID: UUID,
    descriptorUUID: UUID,
    valueBase64: Base64,
    transactionId?: TransactionId
  ): Promise<Descriptor> {
    const peripheral = Kit.getPeripheral(deviceIdentifier);
    const context: ErrorContext = {
      kind: 'writeDescriptor',
      deviceID: deviceIdentifier,
      serviceUUID,
      characteristicUUID,
      descriptorUUID,
    };
    return this.call(context, transactionId, async (signal) => {
      if (uuidOf(descriptorUUID) === CCCD)
        throw this.error(BleErrorCode.DescriptorWriteNotAllowed, context);
      const bytes = fromBase64(valueBase64);
      if (!bytes) {
        throw this.error(
          BleErrorCode.DescriptorInvalidDataFormat,
          context,
          null,
          String(valueBase64)
        );
      }
      this.requireConnected(peripheral);
      await peripheral.writeDescriptor(serviceUUID, characteristicUUID, descriptorUUID, bytes, {
        signal,
      });
      return this.descriptor(
        peripheral.id,
        uuidOf(serviceUUID),
        uuidOf(characteristicUUID),
        uuidOf(descriptorUUID),
        valueBase64
      );
    });
  }

  // Private

  private write(
    deviceIdentifier: DeviceId,
    serviceUUID: UUID,
    characteristicUUID: UUID,
    base64Value: Base64,
    withResponse: boolean,
    transactionId: TransactionId | undefined
  ): Promise<Characteristic> {
    const peripheral = Kit.getPeripheral(deviceIdentifier);
    const context: ErrorContext = {
      kind: 'write',
      deviceID: deviceIdentifier,
      serviceUUID,
      characteristicUUID,
    };
    return this.call(context, transactionId, async (signal) => {
      const bytes = fromBase64(base64Value);
      if (!bytes) {
        throw this.error(
          BleErrorCode.CharacteristicInvalidDataFormat,
          context,
          null,
          String(base64Value)
        );
      }
      this.requireConnected(peripheral);
      await peripheral.write(serviceUUID, characteristicUUID, bytes, { withResponse, signal });
      return this.characteristic(
        peripheral.id,
        uuidOf(serviceUUID),
        uuidOf(characteristicUUID),
        base64Value
      );
    });
  }

  /**
   * Runs an expo-ble-kit call as a ble-plx one: its error converted, cancellable through
   * `transactionId` (a new call with the same id cancels the earlier one), rejected by `destroy()`.
   */
  private call<T>(
    context: ErrorContext,
    transactionId: TransactionId | null | undefined,
    work: (signal: AbortSignal | undefined) => Promise<T>
  ): Promise<T> {
    if (this.destroyed) {
      return Promise.reject(this.error(BleErrorCode.BluetoothManagerDestroyed, context));
    }
    let controller: AbortController | undefined;
    let cancel: (() => void) | undefined;
    if (transactionId) {
      this.cancel(transactionId);
      const created = new AbortController();
      controller = created;
      cancel = () => created.abort();
      this.transactions.set(transactionId, cancel);
    }
    const id = ++this.nextCall;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, reject);
      Promise.resolve()
        .then(() => work(controller?.signal))
        .then(resolve, (error: unknown) => reject(toPlxError(error, context, this.messages)));
    }).finally(() => {
      this.pending.delete(id);
      if (transactionId && this.transactions.get(transactionId) === cancel) {
        this.transactions.delete(transactionId);
      }
    });
  }

  private cancel(transactionId: TransactionId): void {
    const cancel = this.transactions.get(transactionId);
    this.transactions.delete(transactionId);
    cancel?.();
    this.monitors.get(transactionId)?.end(this.error(BleErrorCode.OperationCancelled, {}));
  }

  private stopScan(): void {
    this.scan?.stop();
    this.scan = null;
  }

  private track(remove: () => void): Subscription {
    const subscription: Subscription = {
      remove: () => {
        if (!this.subscriptions.delete(subscription)) return;
        remove();
      },
    };
    this.subscriptions.add(subscription);
    return subscription;
  }

  private error(
    code: BleErrorCode,
    context: Partial<ErrorContext>,
    reason: string | null = null,
    internalMessage?: string
  ): BleError {
    return plxError(code, context, this.messages, reason, internalMessage);
  }

  private requireConnected(peripheral: Peripheral): void {
    if (peripheral.state !== 'connected') {
      throw this.error(BleErrorCode.DeviceNotConnected, { deviceID: peripheral.id });
    }
  }

  private find(
    peripheral: Peripheral,
    serviceUUID: UUID,
    characteristicUUID: UUID
  ): KitCharacteristic | undefined {
    const service = uuidOf(serviceUUID);
    const uuid = uuidOf(characteristicUUID);
    return peripheral.services
      .find(
        (candidate) =>
          candidate.uuid === service && candidate.characteristics.some((c) => c.uuid === uuid)
      )
      ?.characteristics.find((candidate) => candidate.uuid === uuid);
  }

  /** ble-plx's numeric ids, stable per device and attribute. */
  private identifier(...parts: string[]): number {
    const key = parts.join('|');
    let id = this.identifiers.get(key);
    if (id === undefined) {
      id = this.identifiers.size + 1;
      this.identifiers.set(key, id);
    }
    return id;
  }

  private device(peripheral: Peripheral, fields: Partial<NativeDevice> = {}): Device {
    return new Device(
      {
        id: peripheral.id,
        name: peripheral.name,
        rssi: null,
        mtu: peripheral.mtu,
        manufacturerData: null,
        rawScanRecord: '',
        serviceData: null,
        serviceUUIDs: null,
        localName: null,
        txPowerLevel: null,
        solicitedServiceUUIDs: null,
        isConnectable: null,
        overflowServiceUUIDs: null,
        ...fields,
      },
      this
    );
  }

  /** A scan result as ble-plx's Device: manufacturer data with its company id first, as advertised. */
  private scanned(result: ScanResult): Device {
    const [companyId] = Object.keys(result.manufacturerData);
    const manufacturer =
      companyId === undefined
        ? null
        : Uint8Array.of(
            Number(companyId) & 0xff,
            Number(companyId) >> 8,
            ...result.manufacturerData[Number(companyId)]
          );
    const serviceData = Object.entries(result.serviceData);
    return new Device(
      {
        id: result.id,
        name: result.name,
        rssi: result.rssi,
        mtu: 23,
        manufacturerData: manufacturer && toBase64(manufacturer),
        rawScanRecord: result.rawAdvertisement ? toBase64(result.rawAdvertisement) : '',
        serviceData:
          serviceData.length === 0
            ? null
            : Object.fromEntries(serviceData.map(([uuid, data]) => [uuid, toBase64(data)])),
        serviceUUIDs: result.serviceUUIDs.length === 0 ? null : [...result.serviceUUIDs],
        localName: result.name,
        txPowerLevel: result.txPowerLevel,
        solicitedServiceUUIDs: null,
        isConnectable: result.isConnectable,
        overflowServiceUUIDs: null,
      },
      this
    );
  }

  private characteristic(
    deviceID: string,
    serviceUUID: string,
    uuid: string,
    value: Base64 | null
  ): Characteristic {
    const peripheral = Kit.getPeripheral(deviceID);
    const properties = this.find(peripheral, serviceUUID, uuid)?.properties ?? [];
    return new Characteristic(
      {
        id: this.identifier(deviceID, serviceUUID, uuid),
        uuid,
        serviceID: this.identifier(deviceID, serviceUUID),
        serviceUUID,
        deviceID,
        isReadable: properties.includes('read'),
        isWritableWithResponse: properties.includes('write'),
        isWritableWithoutResponse: properties.includes('writeWithoutResponse'),
        isNotifiable: properties.includes('notify'),
        isNotifying: (this.notifying.get(`${deviceID}|${serviceUUID}|${uuid}`) ?? 0) > 0,
        isIndicatable: properties.includes('indicate'),
        value,
      },
      this
    );
  }

  private descriptor(
    deviceID: string,
    serviceUUID: string,
    characteristicUUID: string,
    uuid: string,
    value: Base64 | null
  ): Descriptor {
    return new Descriptor(
      {
        id: this.identifier(deviceID, serviceUUID, characteristicUUID, uuid),
        uuid,
        characteristicID: this.identifier(deviceID, serviceUUID, characteristicUUID),
        characteristicUUID,
        serviceID: this.identifier(deviceID, serviceUUID),
        serviceUUID,
        deviceID,
        value,
      },
      this
    );
  }
}
