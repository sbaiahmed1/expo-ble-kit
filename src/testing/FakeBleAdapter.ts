import type {
  ConnectionStateEvent,
  ExpoBleKitModuleEvents,
  PeripheralObjectEvents,
} from '../ExpoBleKit.types';
import { BleError, BleErrorCode } from '../errors';
import type { NativeAttributeRequest, NativeSubscribeMode } from '../internal/attributeRequest';
import type { NativeConnectOptions } from '../internal/connectOptions';
import { DEFAULT_DISCOVERY_TIMEOUT_MS } from '../internal/connectOptions';
import { GattQueue, type GattOperationKind, type GattResult } from '../internal/gattQueue';
import type { NativeBleKitPort, NativeDiagnostics, NativePeripheralPort } from '../internal/port';
import type { NativeScanOptions } from '../internal/scanOptions';
import { timerScheduler, type Scheduler } from '../internal/scheduler';
import type {
  BlePermissionRequest,
  BlePermissions,
  BleState,
  CharacteristicProperty,
  ConnectionState,
  ScanResult,
  Service,
  Subscription,
} from '../types';
import { normalizeUUID, type UUID } from '../uuid';

// The fake native side for tests (plan §5.8, P1-13). It implements the same port as the native
// module and follows the same rules (plan §4.9, §5.3, §5.4): operations go through the same queue
// semantics (the shared contract in test-contracts/), preconditions reject with the same codes,
// the state listener hears `connected` before connect() resolves, and every pending operation fails
// with DISCONNECTED when a connection ends. Results arrive asynchronously, as from a radio.

export interface VirtualPeripheralConfig {
  id?: string; // generated when omitted
  name?: string;
  rssi?: number; // default -60
  services: {
    uuid: UUID;
    characteristics: {
      uuid: UUID;
      properties: CharacteristicProperty[];
      value?: Uint8Array;
      /** Notify and indicate characteristics also get a CCCD (0x2902). */
      descriptors?: { uuid: UUID; value?: Uint8Array }[];
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
  | 'unsubscribe';

export interface FakeBle {
  addPeripheral(config: VirtualPeripheralConfig): VirtualPeripheral;
  setState(state: BleState): void;
  /** Make the next matching op fail with this code. */
  injectError(
    match: { op: FakeOperation | string; peripheralId?: string; characteristic?: UUID },
    code: BleErrorCode
  ): void;
  reset(): void;
}

export interface VirtualPeripheral {
  readonly id: string;
  advertise(on: boolean): void;
  setValue(service: UUID, characteristic: UUID, value: Uint8Array): void;
  /** Sends a notification or indication, which a connected client receives if it enabled the CCCD. */
  notify(service: UUID, characteristic: UUID, value: Uint8Array): void;
  /** The peripheral side of the CCCD: whether a client has notifications or indications on. */
  isNotifying(service: UUID, characteristic: UUID): boolean;
  disconnect(reason?: 'peer' | 'linkLoss'): void;
  readonly writes: readonly { characteristic: UUID; value: Uint8Array; withResponse: boolean }[];
}

const CCCD = normalizeUUID('2902');
const MAX_ATTRIBUTE_LENGTH = 512;
/** One packet at the default ATT MTU of 23 (Android); iOS reports 20 too until a larger MTU. */
const MAX_WITHOUT_RESPONSE = 20;

const fail = (code: BleErrorCode, message: string) => new BleError(code, message);

/** Minimal synchronous event emitter with Expo's `addListener` shape. */
class Emitter<Events extends Record<string, (event: any) => void>> {
  private readonly listeners = new Map<keyof Events, Set<(event: any) => void>>();

  addListener<E extends keyof Events>(event: E, listener: Events[E]): Subscription {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return { remove: () => set.delete(listener) };
  }

  emit<E extends keyof Events>(event: E, payload: Parameters<Events[E]>[0]): void {
    [...(this.listeners.get(event) ?? [])].forEach((listener) => listener(payload));
  }
}

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

/** A virtual peripheral's radio side. */
class VirtualDevice implements VirtualPeripheral {
  readonly services: Map<UUID, VirtualService>;
  readonly writes: { characteristic: UUID; value: Uint8Array; withResponse: boolean }[] = [];
  readonly name: string | null;
  readonly rssi: number;
  advertising = true;

  constructor(
    readonly id: string,
    config: VirtualPeripheralConfig,
    private readonly adapter: FakeBleAdapter
  ) {
    this.name = config.name ?? null;
    this.rssi = config.rssi ?? -60;
    this.services = new Map(
      config.services.map((service) => {
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
  private readonly emitter = new Emitter<PeripheralObjectEvents>();
  private queue: GattQueue;
  private connectWaiters: { resolve: () => void; reject: (error: BleError) => void }[] = [];
  private disconnectWaiters: (() => void)[] = [];
  private connectOptions: NativeConnectOptions | null = null;
  private cancelConnectTimeout: (() => void) | null = null;
  /** Bumped when a connection attempt ends, so its scheduled steps do nothing. */
  private attempt = 0;
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

  constructor(
    readonly id: string,
    private readonly adapter: FakeBleAdapter,
    private readonly scheduler: Scheduler
  ) {
    this.queue = new GattQueue(scheduler);
  }

  addListener<E extends keyof PeripheralObjectEvents>(
    event: E,
    listener: PeripheralObjectEvents[E]
  ) {
    return this.emitter.addListener(event, listener);
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
      if (this.state === 'connecting') {
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

  discover(services: string[] | null, timeoutMs: number): Promise<Service[]> {
    return this.operation('discoverServices', 'discover', undefined, timeoutMs, () => {
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
    return this.operation('read', 'read', request.characteristic, request.timeoutMs, () =>
      characteristic.value.slice()
    );
  }

  async write(request: NativeAttributeRequest, value: Uint8Array): Promise<void> {
    const property = request.withResponse ? 'write' : 'writeWithoutResponse';
    const characteristic = this.findCharacteristic(
      request,
      [property],
      BleErrorCode.WRITE_NOT_PERMITTED
    );
    const max = request.withResponse ? MAX_ATTRIBUTE_LENGTH : MAX_WITHOUT_RESPONSE;
    if (value.length > max) {
      throw fail(
        BleErrorCode.INVALID_ATTRIBUTE_LENGTH,
        `${value.length} bytes is more than the ${max} allowed here`
      );
    }
    const kind = request.withResponse ? 'write' : 'writeWithoutResponse';
    return this.operation(kind, 'write', request.characteristic, request.timeoutMs, () => {
      characteristic.value = value.slice();
      this.device()?.writes.push({
        characteristic: request.characteristic,
        value: value.slice(),
        withResponse: request.withResponse,
      });
    });
  }

  async readDescriptor(request: NativeAttributeRequest): Promise<Uint8Array> {
    const descriptor = this.findDescriptor(request);
    return this.operation(
      'readDescriptor',
      'readDescriptor',
      request.characteristic,
      request.timeoutMs,
      () => descriptor.value.slice()
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
    return this.operation(
      'writeDescriptor',
      'writeDescriptor',
      request.characteristic,
      request.timeoutMs,
      () => {
        descriptor.value = value.slice();
      }
    );
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
    this.operation('setNotify', 'subscribe', request.characteristic, request.timeoutMs, () => {
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
    await this.operation('setNotify', 'unsubscribe', entry.characteristic.uuid, timeoutMs, () => {
      entry.characteristic.cccd = 'off';
    });
  }

  // Called by the adapter and the virtual device

  deliverNotification(characteristic: UUID, service: UUID, value: Uint8Array): void {
    if (this.subscriptions.get(`${service}/${characteristic}`)?.enabled) {
      this.emitter.emit('notification', { service, characteristic, value, timestamp: Date.now() });
    }
  }

  /** The device started advertising: a pending connect completes. */
  deviceAppeared(): void {
    if (this.state === 'connecting') {
      this.linkUp(this.attempt);
    }
  }

  linkLost(reason: 'peer' | 'linkLoss'): void {
    if (this.state === 'connected' || this.state === 'disconnecting') {
      const message = reason === 'peer' ? 'The peripheral disconnected' : 'The link was lost';
      this.finish(fail(BleErrorCode.DISCONNECTED, message));
    }
  }

  /** Bluetooth went away. */
  forceDisconnected(error: BleError): void {
    if (this.state !== 'disconnected') {
      this.finish(error);
    }
  }

  // Private

  private device(): VirtualDevice | undefined {
    return this.adapter.device(this.id);
  }

  private startConnect(options: NativeConnectOptions): void {
    const attempt = ++this.attempt;
    this.connectOptions = options;
    this.setState('connecting');
    if (options.timeoutMs !== null) {
      const timeoutMs = options.timeoutMs;
      this.cancelConnectTimeout = this.scheduler.scheduleAfter(timeoutMs, () => {
        if (attempt === this.attempt && this.state === 'connecting') {
          this.finish(
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

  private linkUp(attempt: number): void {
    this.scheduler.schedule(() => {
      if (attempt !== this.attempt || this.state !== 'connecting') {
        return;
      }
      const injected = this.adapter.takeError('connect', this.id);
      if (injected) {
        return this.finish(injected);
      }
      if (!this.connectOptions?.autoDiscover) {
        return this.becomeReady();
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
          if (attempt !== this.attempt || this.state !== 'connecting') return;
          if (!result.ok) return this.finish(result.error);
          this.services = this.device()?.serviceList() ?? [];
          this.becomeReady();
        }
      );
    });
  }

  private becomeReady(): void {
    this.cancelConnectTimeout?.();
    this.cancelConnectTimeout = null;
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
    this.services = [];
    // The state changes first, so callbacks of the operations failed below see the final state.
    this.setState('disconnected', error);
    this.queue.failAll(fail(BleErrorCode.DISCONNECTED, 'Disconnected'));
    this.queue = new GattQueue(this.scheduler);
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
    this.emitter.emit('connectionStateChange', event);
  }

  /** Queues an operation answered on a later tick, like a radio (plan §4.9). */
  private operation<T>(
    kind: GattOperationKind,
    op: FakeOperation,
    characteristic: string | undefined,
    timeoutMs: number,
    perform: () => T
  ): Promise<T> {
    if (this.state !== 'connected') {
      return Promise.reject(fail(BleErrorCode.DISCONNECTED, `Not connected to ${this.id}`));
    }
    return new Promise((resolve, reject) => {
      const operation = this.queue.enqueue<T>(
        kind,
        { target: characteristic, timeoutMs },
        () =>
          this.scheduler.schedule(() => {
            const error = this.adapter.takeError(op, this.id, characteristic);
            const result: GattResult<T> = error
              ? { ok: false, error }
              : { ok: true, value: perform() };
            this.queue.complete(result, (current) => current === operation);
          }),
        (result) => (result.ok ? resolve(result.value) : reject(result.error))
      );
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

  async getDiagnosticsAsync(): Promise<NativeDiagnostics> {
    return {
      state: this.state,
      sessions: [...this.handles.values()].map((handle) => ({
        id: handle.id,
        state: handle.state,
        queueDepth: handle.queueDepth,
        subscriptions: 0,
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
    this.errors = [];
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

  permissionError(capability: 'scan' | 'connect'): BleError | null {
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
