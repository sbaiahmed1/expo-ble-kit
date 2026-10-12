import type {
  ConnectionStateEvent,
  ExpoBleKitModuleEvents,
  PeripheralObjectEvents,
} from '../ExpoBleKit.types';
import { BleError, BleErrorCode } from '../errors';
import { Emitter } from './Emitter';
import { FakeGattServer, type VirtualCentral } from './FakeGattServer';
import { FakeL2CAPLink, FakeL2CAPServer, type VirtualL2CAPChannel } from './FakeL2CAP';
import type { NativeAccessoryPickerItem } from '../internal/accessoryPicker';
import type { NativeAdvertisingData, NativeAdvertisingOptions } from '../internal/advertising';
import type {
  NativeAttributeRequest,
  NativeBatch,
  NativeSubscribeMode,
} from '../internal/attributeRequest';
import type { NativeBackgroundTaskOptions } from '../internal/backgroundTask';
import type { NativeConnectOptions } from '../internal/connectOptions';
import { DEFAULT_DISCOVERY_TIMEOUT_MS, reconnectDelay } from '../internal/connectOptions';
import {
  GattQueue,
  type GattOperation,
  type GattOperationKind,
  type GattResult,
} from '../internal/gattQueue';
import type { NativeServiceDefinition } from '../internal/gattServer';
import { NotificationBatcher } from '../internal/notificationBatcher';
import type {
  NativeBleKitPort,
  NativeDiagnostics,
  NativeL2CAPChannelPort,
  NativePeripheralPort,
} from '../internal/port';
import type { NativeScanOptions } from '../internal/scanOptions';
import { timerScheduler, type Scheduler } from '../internal/scheduler';
import type {
  AdvertisingData,
  AdvertisingOptions,
  BlePermissionRequest,
  BlePermissions,
  BleState,
  CharacteristicProperty,
  ConnectionState,
  ForegroundServiceNotification,
  LogLevel,
  Phy,
  ScanResult,
  Service,
} from '../types';
import { normalizeUUID, type UUID } from '../uuid';

// The fake native side for tests (plan §5.8, P1-13). It implements the same port as the native
// module and follows the same rules (plan §4.9, §5.3, §5.4): operations go through the same queue
// semantics (the shared contract in test-contracts/), preconditions reject with the same codes,
// the state listener hears `connected` before connect() resolves, and every pending operation fails
// with DISCONNECTED when a connection ends. Results arrive asynchronously, as from a radio.

/** A virtual peripheral for `FakeBle.addPeripheral`. */
export interface VirtualPeripheralConfig {
  /** The peripheral id. Generated (`fake-1`, `fake-2`…) when omitted. */
  id?: string;
  /** The advertised name. */
  name?: string;
  /** @defaultValue -60 */
  rssi?: number;
  /** The largest ATT MTU the peripheral accepts. Default 23, so nothing above 23 is negotiated. */
  mtu?: number;
  /** Its GATT database. */
  services: {
    /** The service UUID (any form `normalizeUUID` accepts). */
    uuid: UUID;
    /** Its characteristics. */
    characteristics: {
      /** The characteristic UUID. */
      uuid: UUID;
      /** What it allows. */
      properties: CharacteristicProperty[];
      /** Its initial value. Writes replace it. */
      value?: Uint8Array;
      /** Notify and indicate characteristics also get a CCCD (0x2902). */
      descriptors?: {
        /** The descriptor UUID. */
        uuid: UUID;
        /** Its initial value. */
        value?: Uint8Array;
      }[];
    }[];
  }[];
}

/** Operation names for `injectError`. */
export type FakeOperation =
  | 'requestPermissions'
  | 'startScan'
  | 'connect'
  | 'discover'
  | 'read'
  | 'write'
  | 'readDescriptor'
  | 'writeDescriptor'
  | 'subscribe'
  | 'unsubscribe'
  | 'requestMtu'
  | 'readRssi'
  | 'startAdvertising'
  | 'createBond'
  | 'requestConnectionPriority'
  | 'setPreferredPhy'
  | 'openL2CAPChannel'
  | 'publishL2CAPChannel'
  | 'showAccessoryPicker';

/** Controls the fake, from `installFakeBle()`. */
export interface FakeBle {
  /** Adds a virtual peripheral, advertising from now on. */
  addPeripheral(config: VirtualPeripheralConfig): VirtualPeripheral;
  /** Changes the adapter state. Leaving `poweredOn` ends scans and drops connections. */
  setState(state: BleState): void;
  /** Make the next matching op fail with this code. */
  injectError(
    match: { op: FakeOperation | string; peripheralId?: string; characteristic?: UUID },
    code: BleErrorCode
  ): void;
  /** Removes every peripheral and error and restores the initial state and permissions. */
  reset(): void;
  /**
   * A central connected to the open GATT server (`BleManager.openGattServer`), to test the
   * server's handlers. `mtu` (default 23) sets how a long value is read and written.
   */
  connectCentral(options?: { id?: string; mtu?: number }): VirtualCentral;
  /**
   * The running advertisement (`BleManager.startAdvertising`), validated with the defaults
   * applied, or null. The fake records what was asked; it doesn't apply a platform's limits.
   */
  readonly advertisement: {
    /** What is advertised. */
    data: AdvertisingData;
    /** How. */
    options: AdvertisingOptions;
  } | null;
  /**
   * A central opens a channel to the app's L2CAP server with this PSM (`BleManager.publishL2CAPChannel`);
   * the server's channel listener gets the app's end. Rejects with `L2CAP_FAILED` when no server
   * has that PSM.
   */
  openL2CAPChannel(psm: number, options?: { centralId?: string }): Promise<VirtualL2CAPChannel>;
}

/** The peripheral side of a virtual peripheral. */
export interface VirtualPeripheral {
  /** Its id, as `BleManager.getPeripheral` takes it. */
  readonly id: string;
  /** Starts or stops advertising. A pending connect completes when it starts. */
  advertise(on: boolean): void;
  /** Sets a characteristic's value, which the next read returns. */
  setValue(service: UUID, characteristic: UUID, value: Uint8Array): void;
  /** Sends a notification or indication, which a connected client receives if it enabled the CCCD. */
  notify(service: UUID, characteristic: UUID, value: Uint8Array): void;
  /** The peripheral side of the CCCD: whether a client has notifications or indications on. */
  isNotifying(service: UUID, characteristic: UUID): boolean;
  /** What advertising and `readRssi()` report from now on. */
  setRssi(rssi: number): void;
  /** Ends the connection from the peripheral's side; the app sees `DISCONNECTED`. */
  disconnect(reason?: 'peer' | 'linkLoss'): void;
  /**
   * Replaces the GATT database, like a firmware change, and tells a connected client (Service
   * Changed): it discovers again, keeps the subscriptions whose characteristics are still there, and
   * emits `servicesChanged`.
   */
  setServices(services: VirtualPeripheralConfig['services']): void;
  /**
   * Accepts L2CAP channels at `psm` (P5-03): `onChannel` gets the peripheral's end of each one the
   * app opens. Without `onChannel`, the channels send back what they receive (an echo server).
   */
  publishL2CAPChannel(psm: number, onChannel?: (channel: VirtualL2CAPChannel) => void): void;
  /** Every characteristic write the app made, oldest first. */
  readonly writes: readonly {
    /** The characteristic written. */
    characteristic: UUID;
    /** The bytes written. */
    value: Uint8Array;
    /** Whether the app asked for a response. */
    withResponse: boolean;
  }[];
}

const CCCD = normalizeUUID('2902');
const MAX_ATTRIBUTE_LENGTH = 512;
/** writeStream reports progress about this many times, like the native cores. */
const STREAM_PROGRESS_STEPS = 100;
const MIN_MTU = 23;
/** Errors that mean Bluetooth itself went away. */
const ADAPTER_ERRORS: BleErrorCode[] = [
  BleErrorCode.BLUETOOTH_POWERED_OFF,
  BleErrorCode.BLUETOOTH_RESETTING,
  BleErrorCode.BLUETOOTH_UNSUPPORTED,
  BleErrorCode.BLUETOOTH_UNAUTHORIZED,
];
/** The first PSM the systems assign to a published L2CAP channel. */
const FIRST_DYNAMIC_PSM = 0x80;
const MAX_MTU = 517;

const fail = (code: BleErrorCode, message: string) => new BleError(code, message);

interface VirtualAttribute {
  value: Uint8Array;
}
interface VirtualCharacteristic extends VirtualAttribute {
  uuid: UUID;
  properties: CharacteristicProperty[];
  descriptors: Map<UUID, VirtualAttribute>;
  /** What the connected client wrote to the CCCD. */
  cccd: 'off' | 'notify' | 'indicate';
}
interface VirtualService {
  uuid: UUID;
  characteristics: Map<UUID, VirtualCharacteristic>;
}

/** Why the adapter can't scan or connect in `state`; null when poweredOn. */
function adapterError(state: BleState): BleError | null {
  switch (state) {
    case 'poweredOn':
      return null;
    case 'poweredOff':
      return fail(BleErrorCode.BLUETOOTH_POWERED_OFF, 'Bluetooth is off');
    case 'unauthorized':
      return fail(BleErrorCode.BLUETOOTH_UNAUTHORIZED, 'Bluetooth permission is denied');
    case 'unsupported':
      return fail(BleErrorCode.BLUETOOTH_UNSUPPORTED, 'This device has no Bluetooth LE adapter');
    default:
      return fail(BleErrorCode.BLUETOOTH_RESETTING, `Bluetooth is ${state}`);
  }
}

/** A virtual peripheral's GATT database from its config. */
function buildServices(services: VirtualPeripheralConfig['services']): Map<UUID, VirtualService> {
  return new Map(
    services.map((service) => {
      const uuid = normalizeUUID(service.uuid);
      const characteristics = new Map(
        service.characteristics.map((characteristic) => {
          const descriptors = new Map(
            (characteristic.descriptors ?? []).map((descriptor) => [
              normalizeUUID(descriptor.uuid),
              { value: descriptor.value ?? new Uint8Array() },
            ])
          );
          const notifies = characteristic.properties.some(
            (p) => p === 'notify' || p === 'indicate'
          );
          if (notifies && !descriptors.has(CCCD)) {
            descriptors.set(CCCD, { value: new Uint8Array([0, 0]) });
          }
          return [
            normalizeUUID(characteristic.uuid),
            {
              uuid: normalizeUUID(characteristic.uuid),
              properties: characteristic.properties,
              value: characteristic.value ?? new Uint8Array(),
              descriptors,
              cccd: 'off' as const,
            },
          ] as const;
        })
      );
      return [uuid, { uuid, characteristics }] as const;
    })
  );
}

/** A virtual peripheral's radio side. */
class VirtualDevice implements VirtualPeripheral {
  services: Map<UUID, VirtualService>;
  readonly writes: { characteristic: UUID; value: Uint8Array; withResponse: boolean }[] = [];
  readonly name: string | null;
  rssi: number;
  readonly mtu: number;
  advertising = true;
  /** L2CAP servers by PSM (P5-03). */
  readonly l2capServers = new Map<number, (channel: VirtualL2CAPChannel) => void>();

  constructor(
    readonly id: string,
    config: VirtualPeripheralConfig,
    private readonly adapter: FakeBleAdapter
  ) {
    this.name = config.name ?? null;
    this.rssi = config.rssi ?? -60;
    this.mtu = Math.min(Math.max(config.mtu ?? MIN_MTU, MIN_MTU), MAX_MTU);
    this.services = buildServices(config.services);
  }

  setServices(services: VirtualPeripheralConfig['services']): void {
    this.services = buildServices(services);
    this.adapter.servicesChanged(this);
  }

  publishL2CAPChannel(psm: number, onChannel?: (channel: VirtualL2CAPChannel) => void): void {
    this.l2capServers.set(
      psm,
      onChannel ?? ((channel) => channel.onData((data) => channel.write(data)))
    );
  }

  advertise(on: boolean): void {
    this.advertising = on;
    if (on) {
      this.adapter.deviceAdvertised(this);
    }
  }

  setValue(service: UUID, characteristic: UUID, value: Uint8Array): void {
    const target = this.services
      .get(normalizeUUID(service))
      ?.characteristics.get(normalizeUUID(characteristic));
    if (!target) {
      throw new Error(`No characteristic ${characteristic} in service ${service}`);
    }
    target.value = value.slice();
  }

  notify(service: UUID, characteristic: UUID, value: Uint8Array): void {
    const target = this.characteristic(service, characteristic);
    // A peripheral only sends to a client that enabled the CCCD.
    if (target.cccd !== 'off') {
      this.adapter
        .handleFor(this.id)
        .deliverNotification(target.uuid, normalizeUUID(service), value.slice());
    }
  }

  isNotifying(service: UUID, characteristic: UUID): boolean {
    return this.characteristic(service, characteristic).cccd !== 'off';
  }

  setRssi(rssi: number): void {
    this.rssi = rssi;
  }

  characteristic(service: UUID, characteristic: UUID): VirtualCharacteristic {
    const target = this.services
      .get(normalizeUUID(service))
      ?.characteristics.get(normalizeUUID(characteristic));
    if (!target) {
      throw new Error(`No characteristic ${characteristic} in service ${service}`);
    }
    return target;
  }

  /** A non-bonded client's CCCDs reset when it disconnects. */
  clientDisconnected(): void {
    this.services.forEach((service) => service.characteristics.forEach((c) => (c.cccd = 'off')));
  }

  disconnect(reason: 'peer' | 'linkLoss' = 'peer'): void {
    this.adapter.handleFor(this.id).linkLost(reason);
  }

  /** The discovered form (plan §5.4). */
  serviceList(): Service[] {
    return [...this.services.values()].map((service) => ({
      uuid: service.uuid,
      isPrimary: true,
      characteristics: [...service.characteristics.values()].map((characteristic) => ({
        uuid: characteristic.uuid,
        serviceUUID: service.uuid,
        properties: [...characteristic.properties],
        descriptors: [...characteristic.descriptors.keys()].map((uuid) => ({
          uuid,
          characteristicUUID: characteristic.uuid,
        })),
      })),
    }));
  }

  scanResult(): ScanResult {
    return {
      id: this.id,
      name: this.name,
      rssi: this.rssi,
      txPowerLevel: null,
      isConnectable: true,
      serviceUUIDs: [...this.services.keys()],
      serviceData: {},
      manufacturerData: {},
      rawAdvertisement: null,
      timestamp: Date.now(),
    };
  }
}

/** One peripheral's handle: the fake `NativePeripheralPort`. */
class FakePeripheralHandle implements NativePeripheralPort {
  state: ConnectionState = 'disconnected';
  services: Service[] = [];
  mtu = MIN_MTU;
  private readonly emitter = new Emitter<PeripheralObjectEvents>();
  private queue: GattQueue;
  private connectWaiters: { resolve: () => void; reject: (error: BleError) => void }[] = [];
  private disconnectWaiters: (() => void)[] = [];
  private connectOptions: NativeConnectOptions | null = null;
  private cancelConnectTimeout: (() => void) | null = null;
  /** Bumped when a connection attempt ends, so its scheduled steps do nothing. */
  private attempt = 0;
  /** The reconnection attempt running or waiting (1-based); 0 when not reconnecting (P2-01). */
  private reconnectAttempt = 0;
  /** A reconnection attempt is setting up the link (rather than waiting for its delay). */
  private attemptRunning = false;
  private cancelReconnect: (() => void) | null = null;
  /** One CCCD per characteristic, shared by its subscribers (plan §5.4). */
  private subscriptions = new Map<
    string,
    {
      characteristic: VirtualCharacteristic;
      indicate: boolean;
      subscribers: Set<number>;
      waiting: Map<number, { resolve: () => void; reject: (error: BleError) => void }>;
      enabled: boolean;
    }
  >();
  private subscriptionKeys = new Map<number, string>();
  /** The batched subscribers' batchers, by subscription id (P2-04). */
  private batchers = new Map<number, NotificationBatcher>();
  /** Running and queued operations JS may cancel, by the id JS gave them. */
  private cancellable = new Map<number, GattOperation>();
  /** writeStream calls in flight, by operation id. */
  private readonly streams = new Map<number, { cancelled: boolean }>();
  /** Open L2CAP channels (P5-03): they close with the connection. */
  private readonly links = new Set<FakeL2CAPLink>();
  /** L2CAP opens a signal may cancel, by operation id. */
  private readonly opens = new Map<number, (error: BleError) => void>();

  constructor(
    readonly id: string,
    private readonly adapter: FakeBleAdapter,
    private readonly scheduler: Scheduler
  ) {
    this.queue = this.newQueue();
  }

  /** A queue whose settled operations go to the debug log, like the native cores (plan §4.16). */
  private newQueue(): GattQueue {
    const queue = new GattQueue(this.scheduler);
    queue.onSettled = (operation, result, elapsedMs) => {
      const what = [operation.kind, operation.target].filter(Boolean).join(' ');
      const status = result.ok ? 'ok' : `${result.error.code} (${result.error.message})`;
      const when = elapsedMs === null ? 'before it started' : `in ${elapsedMs} ms`;
      this.adapter.log('debug', `${what}: ${status} ${when}`, this.id, operation.id);
    };
    return queue;
  }

  addListener<E extends keyof PeripheralObjectEvents>(
    event: E,
    listener: PeripheralObjectEvents[E]
  ) {
    return this.emitter.addListener(event, listener);
  }

  /** Active subscriptions (their subscriber ids), for diagnostics. */
  get subscriptionCount(): number {
    let count = 0;
    this.subscriptions.forEach((entry) => (count += entry.subscribers.size));
    return count;
  }

  get queueDepth(): number {
    return this.queue.depth;
  }

  connect(options: NativeConnectOptions): Promise<void> {
    const precondition =
      adapterError(this.adapter.state) ?? this.adapter.permissionError('connect');
    if (precondition) {
      return Promise.reject(precondition);
    }
    if (this.state === 'connected') {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      if (this.state === 'connecting' || this.state === 'reconnecting') {
        this.connectWaiters.push({ resolve, reject });
      } else if (this.state === 'disconnecting') {
        this.disconnectWaiters.push(() => this.connect(options).then(resolve, reject));
      } else {
        this.connectWaiters.push({ resolve, reject });
        this.startConnect(options);
      }
    });
  }

  disconnect(): Promise<void> {
    return new Promise((resolve) => {
      switch (this.state) {
        case 'disconnected':
          return resolve();
        case 'disconnecting':
          return this.disconnectWaiters.push(resolve);
        case 'connecting':
          this.disconnectWaiters.push(resolve);
          return this.finish(
            null,
            fail(BleErrorCode.OPERATION_CANCELLED, 'disconnect() cancelled the connection attempt')
          );
        case 'reconnecting':
          this.disconnectWaiters.push(resolve);
          return this.finish(
            null,
            fail(BleErrorCode.OPERATION_CANCELLED, 'disconnect() stopped reconnecting')
          );
        default: {
          this.disconnectWaiters.push(resolve);
          this.setState('disconnecting');
          const attempt = this.attempt;
          this.scheduler.schedule(() => {
            if (attempt === this.attempt) this.finish(null);
          });
        }
      }
    });
  }

  discover(
    services: string[] | null,
    timeoutMs: number,
    operationId: number | null
  ): Promise<Service[]> {
    return this.operation('discoverServices', 'discover', { timeoutMs, operationId }, () => {
      const all = this.device()?.serviceList() ?? [];
      const found = all.filter((service) => !services || services.includes(service.uuid));
      if (!services) {
        this.services = all;
      } else {
        this.services = [...this.services.filter((s) => !services.includes(s.uuid)), ...found];
      }
      return found;
    });
  }

  async read(request: NativeAttributeRequest): Promise<Uint8Array> {
    const characteristic = this.findCharacteristic(
      request,
      ['read'],
      BleErrorCode.READ_NOT_PERMITTED
    );
    return this.operation('read', 'read', request, () => characteristic.value.slice());
  }

  async write(request: NativeAttributeRequest, value: Uint8Array): Promise<void> {
    const property = request.withResponse ? 'write' : 'writeWithoutResponse';
    const characteristic = this.findCharacteristic(
      request,
      [property],
      BleErrorCode.WRITE_NOT_PERMITTED
    );
    // Without response, one packet: MTU − 3.
    const max = request.withResponse ? MAX_ATTRIBUTE_LENGTH : this.mtu - 3;
    if (value.length > max) {
      throw fail(
        BleErrorCode.INVALID_ATTRIBUTE_LENGTH,
        `${value.length} bytes is more than the ${max} allowed here`
      );
    }
    const kind = request.withResponse ? 'write' : 'writeWithoutResponse';
    return this.operation(kind, 'write', request, () => {
      characteristic.value = value.slice();
      this.device()?.writes.push({
        characteristic: request.characteristic,
        value: value.slice(),
        withResponse: request.withResponse,
      });
    });
  }

  /** Like the native cores (P2-03): chunks through the queue, each queuing the next one first. */
  async writeStream(
    request: NativeAttributeRequest,
    data: Uint8Array,
    chunkSize: number | null
  ): Promise<void> {
    const property = request.withResponse ? 'write' : 'writeWithoutResponse';
    const characteristic = this.findCharacteristic(
      request,
      [property],
      BleErrorCode.WRITE_NOT_PERMITTED
    );
    const largest = request.withResponse ? MAX_ATTRIBUTE_LENGTH : this.mtu - 3;
    const size = chunkSize ?? this.mtu - 3;
    if (!Number.isInteger(size) || size < 1 || size > largest) {
      throw fail(
        BleErrorCode.INVALID_ARGUMENT,
        `chunkSize ${size} is outside 1…${largest} for this write type`
      );
    }
    const kind = request.withResponse ? 'write' : 'writeWithoutResponse';
    const step = Math.max(size, Math.floor(data.length / STREAM_PROGRESS_STEPS));
    // Natively the next chunk is queued in the same step as the last one completes, so a cancel
    // always finds one; here the loop resumes later, so a cancel in between is remembered.
    const stream = { cancelled: false };
    const operationId = request.operationId ?? null;
    if (operationId !== null) this.streams.set(operationId, stream);
    try {
      await this.streamChunks(request, data, characteristic, { kind, size, step, stream });
    } finally {
      if (operationId !== null) this.streams.delete(operationId);
    }
  }

  private async streamChunks(
    request: NativeAttributeRequest,
    data: Uint8Array,
    characteristic: VirtualCharacteristic,
    plan: { kind: GattOperationKind; size: number; step: number; stream: { cancelled: boolean } }
  ): Promise<void> {
    const { kind, size, step, stream } = plan;
    let reported = 0;
    for (let offset = 0; offset < data.length; offset += size) {
      const chunk = data.slice(offset, offset + size);
      try {
        if (stream.cancelled) {
          throw fail(BleErrorCode.OPERATION_CANCELLED, 'Operation write was cancelled');
        }
        await this.operation(kind, 'write', { ...request, first: offset > 0 }, () => {
          characteristic.value = chunk;
          this.device()?.writes.push({
            characteristic: request.characteristic,
            value: chunk.slice(),
            withResponse: request.withResponse,
          });
        });
      } catch (error) {
        const failure = error as BleError;
        throw new BleError(
          failure.code,
          `${failure.message} (stream stopped after ${offset} of ${data.length} bytes)`,
          { retryable: failure.retryable }
        );
      }
      const end = offset + chunk.length;
      if (end === data.length || end - reported >= step) {
        reported = end;
        const operationId = request.operationId ?? null;
        this.emitter.emit('streamProgress', { operationId, sent: end, total: data.length });
      }
    }
  }

  async readDescriptor(request: NativeAttributeRequest): Promise<Uint8Array> {
    const descriptor = this.findDescriptor(request);
    return this.operation('readDescriptor', 'readDescriptor', request, () =>
      descriptor.value.slice()
    );
  }

  async writeDescriptor(request: NativeAttributeRequest, value: Uint8Array): Promise<void> {
    if (request.descriptor === CCCD) {
      throw fail(
        BleErrorCode.INVALID_ARGUMENT,
        'The Client Characteristic Configuration descriptor (0x2902) is managed by subscribe()'
      );
    }
    if (value.length > MAX_ATTRIBUTE_LENGTH) {
      throw fail(BleErrorCode.INVALID_ATTRIBUTE_LENGTH, `${value.length} bytes is more than 512`);
    }
    const descriptor = this.findDescriptor(request);
    return this.operation('writeDescriptor', 'writeDescriptor', request, () => {
      descriptor.value = value.slice();
    });
  }

  async subscribe(
    request: NativeAttributeRequest,
    subscriptionId: number,
    mode: NativeSubscribeMode
  ): Promise<void> {
    if (this.subscriptionKeys.has(subscriptionId)) {
      throw fail(BleErrorCode.INVALID_ARGUMENT, `Subscription ${subscriptionId} already exists`);
    }
    const characteristic = this.findCharacteristic(
      request,
      ['notify', 'indicate'],
      BleErrorCode.NOT_SUPPORTED
    );
    const notifies = characteristic.properties.includes('notify');
    const indicates = characteristic.properties.includes('indicate');
    if ((mode === 'notify' && !notifies) || (mode === 'indicate' && !indicates)) {
      throw fail(
        BleErrorCode.NOT_SUPPORTED,
        `Characteristic ${request.characteristic} doesn't support ${mode}`
      );
    }
    const indicate = mode === 'indicate' || (mode === 'auto' && !notifies);
    const key = `${request.service}/${request.characteristic}`;
    let entry = this.subscriptions.get(key);
    if (entry && mode !== 'auto' && entry.indicate !== indicate) {
      throw fail(
        BleErrorCode.INVALID_ARGUMENT,
        `Characteristic ${request.characteristic} is already subscribed`
      );
    }
    this.subscriptionKeys.set(subscriptionId, key);
    if (request.batch) {
      this.batchers.set(subscriptionId, this.batcher(subscriptionId, request.batch));
    }
    if (entry?.enabled) {
      entry.subscribers.add(subscriptionId);
      return;
    }
    const isNew = !entry;
    entry ??= {
      characteristic,
      indicate,
      subscribers: new Set(),
      waiting: new Map(),
      enabled: false,
    };
    const subscription = entry;
    const ready = new Promise<void>((resolve, reject) =>
      subscription.waiting.set(subscriptionId, { resolve, reject })
    );
    if (!isNew) {
      return ready; // The CCCD write is already on its way.
    }
    this.subscriptions.set(key, subscription);
    this.operation('setNotify', 'subscribe', request, () => {
      characteristic.cccd = indicate ? 'indicate' : 'notify';
    }).then(
      () => {
        subscription.enabled = true;
        subscription.waiting.forEach((waiter, id) => {
          subscription.subscribers.add(id);
          waiter.resolve();
        });
        subscription.waiting.clear();
      },
      (error: BleError) => {
        subscription.waiting.forEach((waiter, id) => {
          this.subscriptionKeys.delete(id);
          this.batchers.get(id)?.cancel();
          this.batchers.delete(id);
          waiter.reject(error);
        });
        subscription.waiting.clear();
        if (this.subscriptions.get(key) === subscription && subscription.subscribers.size === 0) {
          this.subscriptions.delete(key);
        }
      }
    );
    return ready;
  }

  async unsubscribe(subscriptionId: number, timeoutMs: number): Promise<void> {
    const key = this.subscriptionKeys.get(subscriptionId);
    this.subscriptionKeys.delete(subscriptionId);
    this.batchers.get(subscriptionId)?.cancel();
    this.batchers.delete(subscriptionId);
    const entry = key === undefined ? undefined : this.subscriptions.get(key);
    if (!key || !entry) {
      return;
    }
    entry.subscribers.delete(subscriptionId);
    entry.waiting
      .get(subscriptionId)
      ?.reject(
        fail(BleErrorCode.OPERATION_CANCELLED, 'unsubscribed before the subscription was ready')
      );
    entry.waiting.delete(subscriptionId);
    if (entry.subscribers.size > 0 || entry.waiting.size > 0) {
      return;
    }
    this.subscriptions.delete(key);
    if (this.state !== 'connected') {
      return;
    }
    const target = { characteristic: entry.characteristic.uuid, timeoutMs };
    await this.operation('setNotify', 'unsubscribe', target, () => {
      entry.characteristic.cccd = 'off';
    });
  }

  /** Negotiates like Android: the smaller of the request and what the peripheral accepts. */
  async requestMtu(mtu: number, timeoutMs: number, operationId: number | null): Promise<number> {
    if (!Number.isInteger(mtu) || mtu < MIN_MTU || mtu > MAX_MTU) {
      throw fail(BleErrorCode.INVALID_ARGUMENT, `MTU ${mtu} is outside ${MIN_MTU}–${MAX_MTU}`);
    }
    const negotiated = await this.operation(
      'requestMtu',
      'requestMtu',
      { timeoutMs, operationId },
      () => Math.min(mtu, this.device()?.mtu ?? MIN_MTU)
    );
    this.updateMtu(negotiated);
    return negotiated;
  }

  readRssi(timeoutMs: number, operationId: number | null): Promise<number> {
    return this.operation(
      'readRssi',
      'readRssi',
      { timeoutMs, operationId },
      () => this.device()?.rssi ?? 0
    );
  }

  /** P5-01 (Android): a connected virtual peripheral bonds on a later tick, like a pairing the user accepts. */
  get bondState(): 'none' | 'bonding' | 'bonded' {
    return this.adapter.isBonded(this.id) ? 'bonded' : 'none';
  }

  /** P5-02 (Android): the fake takes any priority, and the first PHY asked for in each direction. */
  requestConnectionPriority(
    _priority: string,
    timeoutMs: number,
    operationId: number | null
  ): Promise<void> {
    return this.operation(
      'connectionPriority',
      'requestConnectionPriority',
      { timeoutMs, operationId },
      () => {}
    );
  }

  setPreferredPhy(
    tx: Phy[],
    rx: Phy[],
    _codedOption: 's2' | 's8' | null,
    timeoutMs: number,
    operationId: number | null
  ): Promise<{ tx: Phy; rx: Phy }> {
    return this.operation('phy', 'setPreferredPhy', { timeoutMs, operationId }, () => ({
      tx: tx[0],
      rx: rx[0],
    }));
  }

  /**
   * P5-03: not a GATT operation, so it doesn't queue; the channel opens on a later tick when the
   * virtual peripheral published `psm`. The fake doesn't encrypt, so `secure` changes nothing.
   */
  openL2CAPChannel(
    psm: number,
    _secure: boolean,
    _timeoutMs: number,
    operationId: number | null
  ): Promise<NativeL2CAPChannelPort> {
    if (this.state !== 'connected') {
      return Promise.reject(fail(BleErrorCode.DISCONNECTED, `Not connected to ${this.id}`));
    }
    const attempt = this.attempt;
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error: BleError | null, port?: NativeL2CAPChannelPort) => {
        if (settled) return;
        settled = true;
        if (operationId !== null) this.opens.delete(operationId);
        return error ? reject(error) : resolve(port!);
      };
      if (operationId !== null) this.opens.set(operationId, (error) => settle(error));
      this.scheduler.schedule(() => {
        if (settled) return;
        if (attempt !== this.attempt || this.state !== 'connected') {
          return settle(fail(BleErrorCode.DISCONNECTED, `Disconnected from ${this.id}`));
        }
        const injected = this.adapter.takeError('openL2CAPChannel', this.id);
        if (injected) return settle(injected);
        const server = this.device()?.l2capServers.get(psm);
        if (!server) {
          return settle(
            fail(BleErrorCode.L2CAP_FAILED, `${this.id} has no L2CAP server at PSM ${psm}`)
          );
        }
        const link = new FakeL2CAPLink(psm, this.id, this.scheduler, (closed) =>
          this.links.delete(closed)
        );
        this.links.add(link);
        server(link.peer);
        settle(null, link.app);
      });
    });
  }

  createBond(timeoutMs: number, operationId: number | null): Promise<void> {
    return this.operation('bond', 'createBond', { timeoutMs, operationId }, () => {
      this.adapter.bond(this.id);
    });
  }

  async cancelOperation(operationId: number): Promise<void> {
    this.opens.get(operationId)?.(
      fail(BleErrorCode.OPERATION_CANCELLED, 'The L2CAP channel open was cancelled')
    );
    const stream = this.streams.get(operationId);
    if (stream) {
      stream.cancelled = true;
    }
    const operation = this.cancellable.get(operationId);
    if (operation) {
      this.queue.cancel(operation);
    }
  }

  get name(): string | null {
    return this.adapter.nameOf(this.id);
  }

  // Called by the adapter and the virtual device

  /**
   * The device changed its GATT database (P2-06), like the native cores: the cache is emptied and
   * discovered again ahead of queued operations, the subscriptions are moved to the new
   * characteristics (or end when theirs is gone), then `servicesChanged` fires.
   */
  servicesChanged(done: () => void = () => {}): void {
    if (this.state !== 'connected') return done();
    this.services = [];
    this.subscriptions.forEach((entry) => (entry.enabled = false));
    this.operation('discoverServices', 'discover', { timeoutMs: 30_000, first: true }, () => {
      this.services = this.device()?.serviceList() ?? [];
    }).then(
      () => {
        if (this.state !== 'connected') return done();
        this.restoreAfterServiceChange();
        this.emitter.emit('servicesChanged', {});
        done();
      },
      () => done()
    );
  }

  /** Android's hidden cache refresh (P2-06), which the fake always has: discovers again. */
  async refreshGattCache(): Promise<boolean> {
    if (this.state !== 'connected') {
      throw fail(BleErrorCode.DISCONNECTED, `Not connected to ${this.id}`);
    }
    await new Promise<void>((resolve) => this.servicesChanged(resolve));
    return true;
  }

  private restoreAfterServiceChange(): void {
    for (const [key, entry] of [...this.subscriptions]) {
      const [service, uuid] = key.split('/');
      const characteristic = this.device()?.services.get(service)?.characteristics.get(uuid);
      if (!characteristic) {
        const message = `${uuid} is gone after the service change`;
        this.endSubscription(key, entry, fail(BleErrorCode.CHARACTERISTIC_NOT_FOUND, message));
        continue;
      }
      entry.characteristic = characteristic;
      characteristic.cccd = entry.indicate ? 'indicate' : 'notify';
      entry.enabled = true;
    }
  }

  /** Batched subscribers collect the value (P2-04); the others get it as it comes. */
  deliverNotification(characteristic: UUID, service: UUID, value: Uint8Array): void {
    const entry = this.subscriptions.get(`${service}/${characteristic}`);
    if (!entry?.enabled) return;
    const timestamp = Date.now();
    let unbatched = false;
    entry.subscribers.forEach((id) => {
      const batcher = this.batchers.get(id);
      if (batcher) batcher.add(value, timestamp);
      else unbatched = true;
    });
    if (unbatched) {
      this.emitter.emit('notification', { service, characteristic, value, timestamp });
    }
  }

  /** The device started advertising: a pending connect (or reconnection attempt) completes. */
  deviceAppeared(): void {
    if (this.settingUp()) {
      this.linkUp(this.attempt);
    }
  }

  linkLost(reason: 'peer' | 'linkLoss'): void {
    if (this.state === 'connected' || this.state === 'disconnecting') {
      const message = reason === 'peer' ? 'The peripheral disconnected' : 'The link was lost';
      const error = fail(BleErrorCode.DISCONNECTED, message);
      if (this.state === 'connected' && this.connectOptions?.reconnect) {
        this.startReconnecting(error);
      } else {
        this.finish(error);
      }
    }
  }

  /** Bluetooth went away. */
  forceDisconnected(error: BleError): void {
    if (this.state !== 'disconnected') {
      this.finish(error);
    }
  }

  // Private

  /**
   * L2CAP channels belong to the connection (plan §5.5): they close with the adapter's error when
   * Bluetooth went off, else with DISCONNECTED.
   */
  private closeLinks(ended: BleError | null): void {
    const error =
      ended && ADAPTER_ERRORS.includes(ended.code)
        ? ended
        : fail(BleErrorCode.DISCONNECTED, `Disconnected from ${this.id}`);
    [...this.links].forEach((link) => link.close(error));
  }

  private device(): VirtualDevice | undefined {
    return this.adapter.device(this.id);
  }

  private startConnect(options: NativeConnectOptions): void {
    this.connectOptions = options;
    this.setState('connecting');
    this.beginAttempt();
  }

  /** The first connect, or a reconnection attempt: link up when the device advertises, or time out. */
  private beginAttempt(): void {
    const attempt = ++this.attempt;
    const timeoutMs = this.connectOptions?.timeoutMs ?? null;
    if (timeoutMs !== null) {
      this.cancelConnectTimeout = this.scheduler.scheduleAfter(timeoutMs, () => {
        if (attempt === this.attempt && this.settingUp()) {
          this.failAttempt(
            fail(BleErrorCode.CONNECTION_TIMEOUT, `Connecting timed out after ${timeoutMs} ms`)
          );
        }
      });
    }
    // Absent devices: the connect waits ("connect when in range") until it times out or is cancelled.
    if (this.device()?.advertising) {
      this.linkUp(attempt);
    }
  }

  /** Connecting, or a reconnection attempt that is past its delay. */
  private settingUp(): boolean {
    return this.state === 'connecting' || (this.state === 'reconnecting' && this.attemptRunning);
  }

  /** A failed connect rejects; a failed reconnection attempt waits for the next one (P2-01). */
  private failAttempt(error: BleError): void {
    if (this.reconnectAttempt > 0) {
      this.retryReconnect(error);
    } else {
      this.finish(error);
    }
  }

  /** A ready connection was lost and a policy is set: wait, then try again. */
  private startReconnecting(error: BleError): void {
    this.closeLinks(null);
    this.resetLink();
    this.reconnectAttempt = 1;
    this.setState('reconnecting', error);
    if (this.connectOptions?.restoreSubscriptionsOnReconnect) {
      this.subscriptions.forEach((entry) => (entry.enabled = false));
    } else {
      [...this.subscriptions].forEach(([key, entry]) => this.endSubscription(key, entry, error));
    }
    this.scheduleReconnect();
  }

  private retryReconnect(error: BleError): void {
    this.resetLink();
    const policy = this.connectOptions?.reconnect;
    const next = this.reconnectAttempt + 1;
    if (!policy || (policy.maxAttempts !== null && next > policy.maxAttempts)) {
      return this.finish(error);
    }
    this.reconnectAttempt = next;
    this.subscriptions.forEach((entry) => (entry.enabled = false));
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const policy = this.connectOptions?.reconnect;
    if (!policy) return;
    this.cancelReconnect = this.scheduler.scheduleAfter(
      reconnectDelay(policy, this.reconnectAttempt),
      () => {
        this.cancelReconnect = null;
        if (this.state === 'reconnecting' && !this.attemptRunning) {
          this.attemptRunning = true;
          this.beginAttempt();
        }
      }
    );
  }

  /** The link is down: pending operations fail, and the peripheral forgets the CCCDs. */
  private resetLink(): void {
    this.attempt++;
    this.attemptRunning = false;
    this.cancelConnectTimeout?.();
    this.cancelConnectTimeout = null;
    this.services = [];
    this.mtu = MIN_MTU;
    this.queue.failAll(fail(BleErrorCode.DISCONNECTED, 'Disconnected'));
    this.queue = this.newQueue();
    this.device()?.clientDisconnected();
  }

  /** Enables the CCCDs again after a reconnection; a failure (injected `subscribe`) ends one alone. */
  private restoreSubscriptions(): void {
    for (const [key, entry] of [...this.subscriptions]) {
      const error = this.adapter.takeError('subscribe', this.id, entry.characteristic.uuid);
      if (error) {
        this.endSubscription(key, entry, error);
        continue;
      }
      entry.characteristic.cccd = entry.indicate ? 'indicate' : 'notify';
      entry.enabled = true;
    }
  }

  /** A batcher for `subscriptionId`, whose first drop is a BUFFER_OVERFLOW warning (plan §4.10). */
  private batcher(subscriptionId: number, spec: NativeBatch): NotificationBatcher {
    return new NotificationBatcher(
      spec.intervalMs,
      spec.maxItems,
      this.scheduler,
      () =>
        this.adapter.warn(
          BleErrorCode.BUFFER_OVERFLOW,
          `Subscription ${subscriptionId} dropped values: more than ${spec.maxItems} arrived within ` +
            `${spec.intervalMs} ms. Later drops are counted in NotificationBatch.dropped`
        ),
      ({ values, timestamps, dropped }) => {
        const bytes = new Uint8Array(values.reduce((sum, value) => sum + value.length, 0));
        let offset = 0;
        for (const value of values) {
          bytes.set(value, offset);
          offset += value.length;
        }
        const lengths = values.map((value) => value.length);
        this.emitter.emit('notificationBatch', {
          subscriptionId,
          bytes,
          lengths,
          timestamps,
          dropped,
        });
      }
    );
  }

  /** The batched subscribers get what they collected before their subscriptions end with the link. */
  private flushBatches(ids: Iterable<number>): void {
    for (const id of [...ids]) {
      this.batchers.get(id)?.flush();
      this.batchers.delete(id);
    }
  }

  private endSubscription(key: string, entry: { subscribers: Set<number> }, error: BleError): void {
    this.subscriptions.delete(key);
    this.flushBatches(entry.subscribers);
    entry.subscribers.forEach((subscriptionId) => {
      this.subscriptionKeys.delete(subscriptionId);
      this.emitter.emit('subscriptionEnded', {
        subscriptionId,
        code: error.code,
        message: error.message,
      });
    });
  }

  private linkUp(attempt: number): void {
    this.scheduler.schedule(() => {
      if (attempt !== this.attempt || !this.settingUp()) {
        return;
      }
      const injected = this.adapter.takeError('connect', this.id);
      if (injected) {
        return this.failAttempt(injected);
      }
      if (!this.connectOptions?.autoDiscover) {
        return this.exchangeMtu(attempt);
      }
      // autoDiscover runs through the queue before `connected`, inside the connect timeout.
      this.queue.enqueue<Service[]>(
        'discoverServices',
        { timeoutMs: DEFAULT_DISCOVERY_TIMEOUT_MS },
        () =>
          this.scheduler.schedule(() => {
            const error = this.adapter.takeError('discover', this.id);
            this.queue.complete(
              error ? { ok: false, error } : { ok: true, value: undefined },
              (op) => op.kind === 'discoverServices'
            );
          }),
        (result) => {
          if (attempt !== this.attempt || !this.settingUp()) return;
          if (!result.ok) return this.failAttempt(result.error);
          this.services = this.device()?.serviceList() ?? [];
          this.exchangeMtu(attempt);
        }
      );
    });
  }

  /**
   * The last setup step, like Android (plan §4.8): ask for `android.requestMtu`. A failure is a
   * `warning`, not a failed connect. The value is in `mtu` when `connected` is emitted.
   */
  private exchangeMtu(attempt: number): void {
    const requested = this.connectOptions?.android.requestMtu ?? null;
    if (requested === null) {
      return this.becomeReady();
    }
    this.queue.enqueue<number>(
      'requestMtu',
      {},
      () =>
        this.scheduler.schedule(() => {
          const error = this.adapter.takeError('requestMtu', this.id);
          const value = Math.min(requested, this.device()?.mtu ?? MIN_MTU);
          this.queue.complete(
            error ? { ok: false, error } : { ok: true, value },
            (op) => op.kind === 'requestMtu'
          );
        }),
      (result) => {
        if (attempt !== this.attempt || !this.settingUp()) return;
        if (result.ok) {
          this.mtu = result.value;
        } else {
          this.adapter.warn(
            result.error.code,
            `${this.id}: the MTU request after connecting failed, so the MTU stays ${this.mtu}`
          );
        }
        this.becomeReady();
      }
    );
  }

  private updateMtu(mtu: number): void {
    if (mtu !== this.mtu) {
      this.mtu = mtu;
      if (this.state === 'connected') {
        this.emitter.emit('mtuChange', { mtu });
      }
    }
  }

  private becomeReady(): void {
    this.cancelConnectTimeout?.();
    this.cancelConnectTimeout = null;
    this.restoreSubscriptions();
    this.reconnectAttempt = 0;
    this.attemptRunning = false;
    // Once connected, the name the device reports about itself is known.
    this.adapter.recordName(this.id, this.device()?.name ?? null);
    this.setState('connected');
    // The state listener has seen `connected` before connect() resolves (plan §4.8).
    const waiters = this.connectWaiters;
    this.connectWaiters = [];
    waiters.forEach((waiter) => waiter.resolve());
  }

  /** Ends the connection or attempt. `error` goes to the state listener; `connectError` to connect(). */
  private finish(error: BleError | null, connectError?: BleError): void {
    this.attempt++;
    this.cancelConnectTimeout?.();
    this.cancelConnectTimeout = null;
    this.cancelReconnect?.();
    this.cancelReconnect = null;
    this.reconnectAttempt = 0;
    this.attemptRunning = false;
    this.services = [];
    this.mtu = MIN_MTU;
    // Batched subscribers get their last values before JS hears that their subscriptions ended.
    this.flushBatches(this.batchers.keys());
    // The state changes first, so callbacks of the operations failed below see the final state.
    this.setState('disconnected', error);
    this.queue.failAll(fail(BleErrorCode.DISCONNECTED, 'Disconnected'));
    this.queue = this.newQueue();
    this.closeLinks(error);
    // Subscriptions end with the connection (plan §4.8), and the peripheral forgets the CCCDs.
    this.subscriptions.clear();
    this.subscriptionKeys.clear();
    this.device()?.clientDisconnected();
    const failure =
      connectError ??
      error ??
      fail(BleErrorCode.DISCONNECTED, 'Disconnected before the connection was ready');
    const connects = this.connectWaiters;
    this.connectWaiters = [];
    connects.forEach((waiter) => waiter.reject(failure));
    const disconnects = this.disconnectWaiters;
    this.disconnectWaiters = [];
    disconnects.forEach((done) => done());
  }

  private setState(state: ConnectionState, error?: BleError | null): void {
    if (state === this.state) return;
    this.state = state;
    const event: ConnectionStateEvent = { state };
    if (error) {
      event.code = error.code;
      event.message = error.message;
    }
    this.adapter.log(
      error ? 'warn' : 'info',
      error ? `${state}: ${error.code} ${error.message}` : state,
      this.id
    );
    this.emitter.emit('connectionStateChange', event);
  }

  /**
   * Queues an operation answered on a later tick, like a radio (plan §4.9). `operationId` lets
   * `cancelOperation` cancel it.
   */
  private operation<T>(
    kind: GattOperationKind,
    op: FakeOperation,
    target: {
      characteristic?: string;
      timeoutMs: number;
      operationId?: number | null;
      first?: boolean;
    },
    perform: () => T
  ): Promise<T> {
    if (this.state !== 'connected') {
      return Promise.reject(fail(BleErrorCode.DISCONNECTED, `Not connected to ${this.id}`));
    }
    const { characteristic, timeoutMs, operationId, first } = target;
    return new Promise((resolve, reject) => {
      const operation = this.queue.enqueue<T>(
        kind,
        { target: characteristic, timeoutMs, first },
        () =>
          this.scheduler.schedule(() => {
            // A running operation that was cancelled still finishes at the radio; the queue then
            // moves on (its caller was already answered).
            const error = this.adapter.takeError(op, this.id, characteristic);
            const result: GattResult<T> = error
              ? { ok: false, error }
              : { ok: true, value: perform() };
            this.queue.complete(result, (current) => current === operation);
          }),
        (result) => {
          if (operationId != null) this.cancellable.delete(operationId);
          return result.ok ? resolve(result.value) : reject(result.error);
        }
      );
      if (operationId != null) this.cancellable.set(operationId, operation);
    });
  }

  private findCharacteristic(
    request: NativeAttributeRequest,
    properties: CharacteristicProperty[],
    notPermitted: BleErrorCode
  ): VirtualCharacteristic {
    if (this.state !== 'connected') {
      throw fail(BleErrorCode.DISCONNECTED, `Not connected to ${this.id}`);
    }
    if (!this.services.some((service) => service.uuid === request.service)) {
      throw fail(
        BleErrorCode.SERVICE_NOT_FOUND,
        `Service ${request.service} not found; discover() it first`
      );
    }
    const characteristic = this.device()
      ?.services.get(request.service)
      ?.characteristics.get(request.characteristic);
    if (!characteristic) {
      throw fail(
        BleErrorCode.CHARACTERISTIC_NOT_FOUND,
        `Characteristic ${request.characteristic} not found in ${request.service}`
      );
    }
    if (!properties.some((property) => characteristic.properties.includes(property))) {
      throw fail(notPermitted, `Characteristic ${request.characteristic} doesn't allow this`);
    }
    return characteristic;
  }

  private findDescriptor(request: NativeAttributeRequest): VirtualAttribute {
    const characteristic = this.findCharacteristic(
      request,
      [
        'broadcast',
        'read',
        'writeWithoutResponse',
        'write',
        'notify',
        'indicate',
        'authenticatedSignedWrites',
        'extendedProperties',
      ],
      BleErrorCode.INTERNAL
    );
    const descriptor = request.descriptor
      ? characteristic.descriptors.get(request.descriptor)
      : undefined;
    if (!descriptor) {
      throw fail(
        BleErrorCode.DESCRIPTOR_NOT_FOUND,
        `Descriptor ${request.descriptor} not found on ${request.characteristic}`
      );
    }
    return descriptor;
  }
}

/** The fake `NativeBleKitPort`. */
export class FakeBleAdapter implements NativeBleKitPort {
  state: BleState;
  permissions: BlePermissions;
  private readonly emitter = new Emitter<ExpoBleKitModuleEvents>();
  private readonly devices = new Map<string, VirtualDevice>();
  private readonly handles = new Map<string, FakePeripheralHandle>();
  private readonly sessions = new Map<number, { options: NativeScanOptions; seen: Set<string> }>();
  /** Names seen in scans or once connected, like the native cores (plan §4.7). */
  private readonly names = new Map<string, string>();
  private errors: {
    match: { op: string; peripheralId?: string; characteristic?: UUID };
    code: BleErrorCode;
  }[] = [];
  private nextId = 1;

  constructor(
    private readonly initial: { state: BleState; permissions: BlePermissions },
    private readonly scheduler: Scheduler = timerScheduler
  ) {
    this.state = initial.state;
    this.permissions = { ...initial.permissions };
  }

  // NativeBleKitPort

  getState(): BleState {
    return this.state;
  }

  async getPermissionsAsync(): Promise<BlePermissions> {
    return { ...this.permissions };
  }

  async requestPermissionsAsync(_request?: BlePermissionRequest): Promise<BlePermissions> {
    const error = this.takeError('requestPermissions');
    if (error) throw error;
    return { ...this.permissions };
  }

  async startScan(sessionId: number, options: NativeScanOptions): Promise<void> {
    const precondition =
      this.takeError('startScan') ?? adapterError(this.state) ?? this.permissionError('scan');
    if (precondition) throw precondition;
    if (this.sessions.has(sessionId)) {
      throw fail(BleErrorCode.INVALID_ARGUMENT, `Scan session ${sessionId} is already running`);
    }
    this.sessions.set(sessionId, { options, seen: new Set() });
    this.scheduler.schedule(() => {
      [...this.devices.values()]
        .filter((d) => d.advertising)
        .forEach((d) => this.deliver(sessionId, d));
    });
  }

  async stopScan(sessionId: number): Promise<void> {
    this.sessions.delete(sessionId);
  }

  getPeripheral(id: string): NativePeripheralPort {
    return this.handleFor(id);
  }

  /** Like iOS: unknown ids (no virtual peripheral) are dropped. */
  async getKnownPeripherals(ids: string[]): Promise<string[]> {
    const precondition = adapterError(this.state);
    if (precondition) throw precondition;
    return [...new Set(ids)].filter((id) => this.devices.has(id));
  }

  /** Peripherals this app connected, with one of `services`. */
  async getSystemConnectedPeripherals(services: string[]): Promise<string[]> {
    const precondition = adapterError(this.state) ?? this.permissionError('connect');
    if (precondition) throw precondition;
    return [...this.handles.values()]
      .filter((handle) => handle.state === 'connected')
      .filter((handle) => services.some((uuid) => this.devices.get(handle.id)?.services.has(uuid)))
      .map((handle) => handle.id);
  }

  async getDiagnosticsAsync(): Promise<NativeDiagnostics> {
    return {
      state: this.state,
      sessions: [...this.handles.values()].map((handle) => ({
        id: handle.id,
        state: handle.state,
        queueDepth: handle.queueDepth,
        subscriptions: handle.subscriptionCount,
      })),
    };
  }

  addListener<E extends keyof ExpoBleKitModuleEvents>(
    event: E,
    listener: ExpoBleKitModuleEvents[E]
  ) {
    return this.emitter.addListener(event, listener);
  }

  // FakeBle controls

  addPeripheral(config: VirtualPeripheralConfig): VirtualPeripheral {
    const id = config.id ?? `fake-${this.nextId++}`;
    const device = new VirtualDevice(id, config, this);
    this.devices.set(id, device);
    this.deviceAdvertised(device);
    return device;
  }

  setState(state: BleState): void {
    if (state === this.state) return;
    this.state = state;
    this.emitter.emit('stateChange', { state });
    const error = adapterError(state);
    if (error) {
      // Like the native cores: scans end, and every connection drops with the adapter's error.
      for (const sessionId of [...this.sessions.keys()]) {
        this.sessions.delete(sessionId);
        this.emitter.emit('scanError', { sessionId, code: error.code, message: error.message });
      }
      this.handles.forEach((handle) => handle.forceDisconnected(error));
      this.server?.close();
      this.advertising = null;
      [...this.l2capServers.values()].forEach((server) => server.shut(error));
    }
  }

  injectError(
    match: { op: string; peripheralId?: string; characteristic?: UUID },
    code: BleErrorCode
  ): void {
    const characteristic =
      match.characteristic === undefined ? undefined : normalizeUUID(match.characteristic);
    this.errors.push({ match: { ...match, characteristic }, code });
  }

  reset(): void {
    this.handles.forEach((handle) =>
      handle.forceDisconnected(fail(BleErrorCode.DISCONNECTED, 'The fake was reset'))
    );
    this.handles.clear();
    this.devices.clear();
    this.sessions.clear();
    this.names.clear();
    this.errors = [];
    this.server?.close();
    this.advertising = null;
    [...this.l2capServers.values()].forEach((server) => server.shut(null));
    this.nextPsm = FIRST_DYNAMIC_PSM;
    this.bonded.clear();
    this.state = this.initial.state;
    this.permissions = { ...this.initial.permissions };
  }

  // Internal, for the handles and devices

  device(id: string): VirtualDevice | undefined {
    return this.devices.get(id);
  }

  handleFor(id: string): FakePeripheralHandle {
    let handle = this.handles.get(id);
    if (!handle) {
      handle = new FakePeripheralHandle(id, this, this.scheduler);
      this.handles.set(id, handle);
    }
    return handle;
  }

  servicesChanged(device: VirtualDevice): void {
    this.handles.get(device.id)?.servicesChanged();
  }

  deviceAdvertised(device: VirtualDevice): void {
    this.scheduler.schedule(() => {
      if (!device.advertising || this.state !== 'poweredOn') return;
      [...this.sessions.keys()].forEach((sessionId) => this.deliver(sessionId, device));
      this.handles.get(device.id)?.deviceAppeared();
    });
  }

  /** The first injected error matching `op`, consumed. */
  takeError(op: string, peripheralId?: string, characteristic?: string): BleError | null {
    const index = this.errors.findIndex(
      ({ match }) =>
        match.op === op &&
        (match.peripheralId === undefined || match.peripheralId === peripheralId) &&
        (match.characteristic === undefined || match.characteristic === characteristic)
    );
    if (index < 0) return null;
    const [{ code }] = this.errors.splice(index, 1);
    return fail(code, `Injected ${code} for ${op}`);
  }

  warn(code: BleErrorCode, message: string): void {
    this.log('warn', `${code}: ${message}`);
    this.emitter.emit('warning', { code, message });
  }

  // The log (plan §4.16), like the native cores: lines at or above the level, as `log` events
  // while JS forwards them.

  private logLevel: LogLevel = 'warn';
  private logForwarding = false;

  setLogLevel(level: LogLevel): void {
    this.logLevel = level;
  }

  setLogForwarding(enabled: boolean): void {
    this.logForwarding = enabled;
  }

  /**
   * Background tasks: as Android registers background scans (P3-04), with the `backgroundScan`
   * permission and an adapter that is on; iOS's restoration events (P3-02) need neither. The fake
   * has no TaskManager to deliver to, so it only keeps them.
   */
  readonly backgroundTasks = new Map<string, NativeBackgroundTaskOptions>();

  async registerBackgroundTask(
    taskName: string,
    options: NativeBackgroundTaskOptions
  ): Promise<void> {
    if (options.scan) {
      const precondition = adapterError(this.state) ?? this.permissionError('backgroundScan');
      if (precondition) throw precondition;
    }
    this.backgroundTasks.set(taskName, options);
  }

  async unregisterBackgroundTask(taskName: string): Promise<void> {
    this.backgroundTasks.delete(taskName);
  }

  /**
   * The GATT server (P4-01), one at a time, behind the same preconditions as the native cores; it
   * closes when the adapter leaves `poweredOn`. `connectCentral` gives tests a central to drive it.
   */
  private server: FakeGattServer | null = null;

  async openGattServer(services: NativeServiceDefinition[]): Promise<FakeGattServer> {
    const precondition = adapterError(this.state) ?? this.permissionError('connect');
    if (precondition) throw precondition;
    if (this.server)
      throw fail(BleErrorCode.INVALID_ARGUMENT, 'A GATT server is already open: close it first');
    const server = new FakeGattServer(
      services,
      this.scheduler,
      (code, message) => this.warn(code, message),
      () => {
        if (this.server === server) this.server = null;
      }
    );
    this.server = server;
    await new Promise<void>((resolve) => this.scheduler.schedule(resolve));
    return server;
  }

  /** Peripherals bonded with `createBond` (P5-01), until `reset()`. */
  private bonded = new Set<string>();

  isBonded(id: string): boolean {
    return this.bonded.has(id);
  }

  bond(id: string): void {
    this.bonded.add(id);
  }

  /** The advertisement (P4-03): one at a time, ended when the adapter leaves `poweredOn`. */
  private advertising: {
    id: number;
    data: NativeAdvertisingData;
    options: NativeAdvertisingOptions;
  } | null = null;

  private nextAdvertisement = 1;

  async startAdvertising(
    data: NativeAdvertisingData,
    options: NativeAdvertisingOptions
  ): Promise<number> {
    const precondition =
      this.takeError('startAdvertising') ??
      adapterError(this.state) ??
      this.permissionError('advertise');
    if (precondition) throw precondition;
    if (this.advertising) {
      throw fail(
        BleErrorCode.ADVERTISING_FAILED,
        'Already advertising: stop the current advertisement first'
      );
    }
    const id = this.nextAdvertisement++;
    this.advertising = { id, data, options };
    await new Promise<void>((resolve) => this.scheduler.schedule(resolve));
    return id;
  }

  async stopAdvertising(id: number): Promise<void> {
    if (this.advertising?.id === id) this.advertising = null;
  }

  /** The public shape of the running advertisement, for `FakeBle.advertisement`. */
  currentAdvertisement(): FakeBle['advertisement'] {
    if (!this.advertising) return null;
    const { data, options } = this.advertising;
    const { connectable, ...android } = options;
    return {
      data: {
        ...(data.localName !== undefined && { localName: data.localName }),
        serviceUUIDs: data.serviceUuids,
        ...(data.manufacturerData && { manufacturerData: data.manufacturerData }),
        serviceData: Object.fromEntries(data.serviceData.map((entry) => [entry.uuid, entry.data])),
        includeTxPower: data.includeTxPower,
      },
      options: { connectable, android },
    };
  }

  connectCentral(options: { id?: string; mtu?: number } = {}): VirtualCentral {
    if (!this.server) throw fail(BleErrorCode.DISCONNECTED, 'No GATT server is open');
    return this.server.connect(options.id ?? `central-${this.nextId++}`, options.mtu ?? MIN_MTU);
  }

  /**
   * AccessorySetupKit's picker (P5-04): the person picks the first advertising virtual peripheral
   * that matches an item (its service, and its name when the item names a part of it), on a later
   * tick; nothing matching answers null, like a picker closed empty. The fake has no Info.plist
   * to check.
   */
  async showAccessoryPicker(
    items: NativeAccessoryPickerItem[],
    _timeoutMs: number
  ): Promise<string | null> {
    const injected = this.takeError('showAccessoryPicker');
    await new Promise<void>((resolve) => this.scheduler.schedule(resolve));
    if (injected) throw injected;
    const picked = [...this.devices.values()].find(
      (device) =>
        device.advertising &&
        items.some(
          (item) =>
            item.service !== null &&
            device.services.has(item.service) &&
            (item.nameSubstring === null || (device.name ?? '').includes(item.nameSubstring))
        )
    );
    return picked?.id ?? null;
  }

  /** The app's L2CAP servers by PSM (P5-03); several may run. Bluetooth off closes them. */
  private readonly l2capServers = new Map<number, FakeL2CAPServer>();
  private nextPsm = FIRST_DYNAMIC_PSM;

  async publishL2CAPChannel(_secure: boolean): Promise<FakeL2CAPServer> {
    const precondition =
      this.takeError('publishL2CAPChannel') ??
      adapterError(this.state) ??
      this.permissionError('connect');
    if (precondition) throw precondition;
    const psm = this.nextPsm;
    this.nextPsm = this.nextPsm === 0xff ? FIRST_DYNAMIC_PSM : this.nextPsm + 1;
    const server = new FakeL2CAPServer(psm, this.scheduler, (closed) => {
      if (this.l2capServers.get(closed.psm) === closed) this.l2capServers.delete(closed.psm);
    });
    this.l2capServers.set(psm, server);
    await new Promise<void>((resolve) => this.scheduler.schedule(resolve));
    return server;
  }

  openL2CAPChannel(
    psm: number,
    options: { centralId?: string } = {}
  ): Promise<VirtualL2CAPChannel> {
    const server = this.l2capServers.get(psm);
    if (!server || this.state !== 'poweredOn') {
      return Promise.reject(fail(BleErrorCode.L2CAP_FAILED, `No L2CAP server at PSM ${psm}`));
    }
    return server.accept(options.centralId ?? `central-${this.nextId++}`);
  }

  /** Android's keep-alive notification (P3-03). The fake keeps it; it has no service to show it. */
  foregroundServiceNotification: ForegroundServiceNotification = {};

  setForegroundServiceNotification(notification: ForegroundServiceNotification): void {
    this.foregroundServiceNotification = notification;
  }

  log(level: LogLevel, message: string, peripheralId?: string, opId?: number): void {
    const levels: LogLevel[] = ['none', 'error', 'warn', 'info', 'debug', 'verbose'];
    if (!this.logForwarding || level === 'none') return;
    if (levels.indexOf(level) > levels.indexOf(this.logLevel)) return;
    const timestamp = Date.now();
    this.emitter.emit('log', { level, message, timestamp, peripheralId, opId });
  }

  nameOf(id: string): string | null {
    return this.names.get(id) ?? null;
  }

  recordName(id: string, name: string | null): void {
    if (name) this.names.set(id, name);
  }

  permissionError(
    capability: 'scan' | 'connect' | 'advertise' | 'backgroundScan'
  ): BleError | null {
    return this.permissions[capability] === 'granted'
      ? null
      : fail(
          BleErrorCode.PERMISSION_DENIED,
          `The ${capability} permission is ${this.permissions[capability]}`
        );
  }

  private deliver(sessionId: number, device: VirtualDevice): void {
    const session = this.sessions.get(sessionId);
    if (!session || !matches(session.options, device)) return;
    if (!session.options.allowDuplicates) {
      if (session.seen.has(device.id)) return;
      session.seen.add(device.id);
    }
    const results = [device.scanResult()];
    this.recordName(device.id, device.name);
    if (session.options.reportIntervalMs > 0) {
      this.scheduler.scheduleAfter(session.options.reportIntervalMs, () => {
        if (this.sessions.get(sessionId) === session) {
          this.emitter.emit('scanResults', { sessionId, results });
        }
      });
    } else {
      this.emitter.emit('scanResults', { sessionId, results });
    }
  }
}

/** Plan §5.3: every given criterion must match. Virtual peripherals advertise no manufacturer data. */
function matches(options: NativeScanOptions, device: VirtualDevice): boolean {
  if (options.services.length > 0 && !options.services.some((uuid) => device.services.has(uuid))) {
    return false;
  }
  if (options.namePrefix !== undefined && !(device.name ?? '').startsWith(options.namePrefix)) {
    return false;
  }
  return options.manufacturerData.length === 0;
}
