import type { ConnectionStateEvent, PeripheralObjectEvents } from '../ExpoBleKit.types';
import { BleError, BleErrorCode } from '../errors';
import type {
  NativeAttributeRequest,
  NativeBatch,
  NativeSubscribeMode,
} from '../internal/attributeRequest';
import {
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  MIN_MTU,
  type NativeConnectOptions,
} from '../internal/connectOptions';
import { Emitter } from '../internal/emitter';
import { GattQueue, type GattOperation, type GattOperationKind } from '../internal/gattQueue';
import { NotificationBatcher } from '../internal/notificationBatcher';
import type { NativeL2CAPChannelPort, NativePeripheralPort } from '../internal/port';
import type { Scheduler } from '../internal/scheduler';
import type { CharacteristicProperty, ConnectionState, LogLevel, Service } from '../types';
import { normalizeUUID } from '../uuid';
import type { WebBluetoothDevice, WebGattCharacteristic, WebGattDescriptor } from './bluetooth';
import { fromWebError, isNotFound } from './errors';

const CCCD = normalizeUUID('2902');
const MAX_ATTRIBUTE_LENGTH = 512;
const STREAM_PROGRESS_STEPS = 100;

const fail = (code: BleErrorCode, message: string) => new BleError(code, message);

/** What a peripheral needs from the adapter. */
export interface WebPeripheralHost {
  readonly scheduler: Scheduler;
  /** The browser's device for `id`: picked in this page, or allowed earlier. */
  device(id: string): WebBluetoothDevice | undefined;
  /** BLUETOOTH_UNSUPPORTED or BLUETOOTH_POWERED_OFF while the adapter can't be used. */
  adapterError(): BleError | null;
  log(level: LogLevel, message: string, peripheralId?: string, opId?: number): void;
  warn(code: BleErrorCode, message: string): void;
}

type Subscription = {
  characteristic: WebGattCharacteristic;
  service: string;
  uuid: string;
  subscribers: Set<number>;
  waiting: Map<number, { resolve: () => void; reject: (error: BleError) => void }>;
  enabled: boolean;
  listener: ((event: Event) => void) | null;
};

/**
 * One peripheral over Web Bluetooth (P6-02): the central subset of `NativePeripheralPort`. GATT
 * operations go through the TypeScript twin of the native queue, one at a time (Chrome rejects a
 * second one while one runs), with the same timeouts and cancellation. The browser negotiates the
 * MTU and keeps it to itself, so `mtu` stays 23 and writes without response are cut to 20 bytes.
 */
export class WebPeripheral implements NativePeripheralPort {
  state: ConnectionState = 'disconnected';
  services: Service[] = [];
  readonly mtu = MIN_MTU;
  private readonly emitter = new Emitter<PeripheralObjectEvents>();
  private queue: GattQueue;
  private connectWaiters: { resolve: () => void; reject: (error: BleError) => void }[] = [];
  private cancelConnectTimeout: (() => void) | null = null;
  /** Bumped when a connection ends, so the steps of an older one do nothing. */
  private attempt = 0;
  /** The discovered attributes, by `service/characteristic(/descriptor)`. */
  private characteristics = new Map<string, WebGattCharacteristic>();
  private descriptors = new Map<string, WebGattDescriptor>();
  private subscriptions = new Map<string, Subscription>();
  private subscriptionKeys = new Map<number, string>();
  private batchers = new Map<number, NotificationBatcher>();
  private cancellable = new Map<number, GattOperation>();
  private readonly streams = new Map<number, { cancelled: boolean }>();
  private watched: WebBluetoothDevice | null = null;

  constructor(
    readonly id: string,
    private readonly host: WebPeripheralHost
  ) {
    this.queue = this.newQueue();
  }

  get name(): string | null {
    return this.host.device(this.id)?.name ?? null;
  }

  get subscriptionCount(): number {
    let count = 0;
    this.subscriptions.forEach((entry) => (count += entry.subscribers.size));
    return count;
  }

  get queueDepth(): number {
    return this.queue.depth;
  }

  addListener<E extends keyof PeripheralObjectEvents>(
    event: E,
    listener: PeripheralObjectEvents[E]
  ) {
    return this.emitter.addListener(event, listener);
  }

  connect(options: NativeConnectOptions): Promise<void> {
    const precondition = this.host.adapterError();
    if (precondition) return Promise.reject(precondition);
    if (options.reconnect) {
      return Promise.reject(
        fail(BleErrorCode.NOT_SUPPORTED, 'Connect option reconnect is not supported on the web')
      );
    }
    if (options.keepAliveInBackground) {
      return Promise.reject(
        fail(BleErrorCode.NOT_SUPPORTED, 'Connect option keepAliveInBackground is Android-only')
      );
    }
    const device = this.host.device(this.id);
    if (!device?.gatt) {
      return Promise.reject(
        fail(
          BleErrorCode.PERIPHERAL_NOT_FOUND,
          `${this.id} is unknown to this page: pick it in the browser's chooser (startScan) first`
        )
      );
    }
    if (this.state === 'connected') return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.connectWaiters.push({ resolve, reject });
      if (this.state !== 'connecting') this.startConnect(device, options);
    });
  }

  disconnect(): Promise<void> {
    const device = this.host.device(this.id);
    switch (this.state) {
      case 'disconnected':
        return Promise.resolve();
      case 'connecting':
        device?.gatt?.disconnect();
        this.finish(
          null,
          fail(BleErrorCode.OPERATION_CANCELLED, 'disconnect() cancelled the connection attempt')
        );
        return Promise.resolve();
      default:
        return new Promise((resolve) => {
          this.setState('disconnecting');
          device?.gatt?.disconnect();
          // The browser fires gattserverdisconnected later; the link is down already.
          const attempt = this.attempt;
          this.host.scheduler.schedule(() => {
            if (attempt === this.attempt) this.finish(null);
            resolve();
          });
        });
    }
  }

  discover(
    services: string[] | null,
    timeoutMs: number,
    operationId: number | null
  ): Promise<Service[]> {
    return this.operation('discoverServices', { timeoutMs, operationId }, async () => {
      const found = await this.readServices(services);
      this.services = services
        ? [...this.services.filter((s) => !services.includes(s.uuid)), ...found]
        : found;
      return found;
    });
  }

  async read(request: NativeAttributeRequest): Promise<Uint8Array> {
    const characteristic = this.characteristic(request, ['read'], BleErrorCode.READ_NOT_PERMITTED);
    return this.operation(
      'read',
      request,
      async () => bytes(await characteristic.readValue()),
      BleErrorCode.READ_NOT_PERMITTED
    );
  }

  async write(request: NativeAttributeRequest, value: Uint8Array): Promise<void> {
    const characteristic = this.writable(request);
    const max = request.withResponse ? MAX_ATTRIBUTE_LENGTH : this.mtu - 3;
    if (value.length > max) {
      throw fail(
        BleErrorCode.INVALID_ATTRIBUTE_LENGTH,
        `${value.length} bytes is more than the ${max} allowed here`
      );
    }
    return this.operation(
      request.withResponse ? 'write' : 'writeWithoutResponse',
      request,
      () => writeValue(characteristic, value, request.withResponse),
      BleErrorCode.WRITE_NOT_PERMITTED
    );
  }

  /** Chunks through the queue like the native cores (P2-03), each queuing the next one first. */
  async writeStream(
    request: NativeAttributeRequest,
    data: Uint8Array,
    chunkSize: number | null
  ): Promise<void> {
    const characteristic = this.writable(request);
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
    const stream = { cancelled: false };
    const operationId = request.operationId ?? null;
    if (operationId !== null) this.streams.set(operationId, stream);
    let reported = 0;
    try {
      for (let offset = 0; offset < data.length; offset += size) {
        const chunk = data.slice(offset, offset + size);
        try {
          if (stream.cancelled)
            throw fail(BleErrorCode.OPERATION_CANCELLED, 'Operation write was cancelled');
          await this.operation(
            kind,
            { ...request, first: offset > 0 },
            () => writeValue(characteristic, chunk, request.withResponse),
            BleErrorCode.WRITE_NOT_PERMITTED
          );
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
          this.emitter.emit('streamProgress', { operationId, sent: end, total: data.length });
        }
      }
    } finally {
      if (operationId !== null) this.streams.delete(operationId);
    }
  }

  async readDescriptor(request: NativeAttributeRequest): Promise<Uint8Array> {
    const descriptor = this.descriptor(request);
    return this.operation(
      'readDescriptor',
      request,
      async () => bytes(await descriptor.readValue()),
      BleErrorCode.READ_NOT_PERMITTED
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
    const descriptor = this.descriptor(request);
    return this.operation(
      'writeDescriptor',
      request,
      () => descriptor.writeValue(value),
      BleErrorCode.WRITE_NOT_PERMITTED
    );
  }

  /**
   * The browser picks notifications when a characteristic has both, like iOS: `indicate` on such a
   * characteristic rejects with NOT_SUPPORTED.
   */
  async subscribe(
    request: NativeAttributeRequest,
    subscriptionId: number,
    mode: NativeSubscribeMode
  ): Promise<void> {
    if (this.subscriptionKeys.has(subscriptionId)) {
      throw fail(BleErrorCode.INVALID_ARGUMENT, `Subscription ${subscriptionId} already exists`);
    }
    const characteristic = this.characteristic(
      request,
      ['notify', 'indicate'],
      BleErrorCode.NOT_SUPPORTED
    );
    const { notify, indicate } = characteristic.properties;
    if ((mode === 'notify' && !notify) || (mode === 'indicate' && !indicate)) {
      throw fail(
        BleErrorCode.NOT_SUPPORTED,
        `Characteristic ${request.characteristic} doesn't support ${mode}`
      );
    }
    if (mode === 'indicate' && notify) {
      throw fail(
        BleErrorCode.NOT_SUPPORTED,
        `The browser subscribes to notifications of ${request.characteristic}, which also indicates`
      );
    }
    const key = `${request.service}/${request.characteristic}`;
    this.subscriptionKeys.set(subscriptionId, key);
    if (request.batch)
      this.batchers.set(subscriptionId, this.batcher(subscriptionId, request.batch));
    let entry = this.subscriptions.get(key);
    if (entry?.enabled) {
      entry.subscribers.add(subscriptionId);
      return;
    }
    const isNew = !entry;
    entry ??= {
      characteristic,
      service: request.service,
      uuid: request.characteristic,
      subscribers: new Set(),
      waiting: new Map(),
      enabled: false,
      listener: null,
    };
    const subscription = entry;
    const ready = new Promise<void>((resolve, reject) =>
      subscription.waiting.set(subscriptionId, { resolve, reject })
    );
    if (!isNew) return ready;
    this.subscriptions.set(key, subscription);
    this.operation('setNotify', request, async () => {
      await characteristic.startNotifications();
    }).then(
      () => {
        subscription.enabled = true;
        subscription.listener = (event) => {
          const value = (event.target as WebGattCharacteristic | null)?.value;
          if (value) this.deliver(subscription, bytes(value));
        };
        characteristic.addEventListener('characteristicvaluechanged', subscription.listener);
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
    if (!key || !entry) return;
    entry.subscribers.delete(subscriptionId);
    entry.waiting
      .get(subscriptionId)
      ?.reject(
        fail(BleErrorCode.OPERATION_CANCELLED, 'unsubscribed before the subscription was ready')
      );
    entry.waiting.delete(subscriptionId);
    if (entry.subscribers.size > 0 || entry.waiting.size > 0) return;
    this.subscriptions.delete(key);
    this.stopListening(entry);
    if (this.state !== 'connected') return;
    await this.operation('setNotify', { characteristic: entry.uuid, timeoutMs }, async () => {
      await entry.characteristic.stopNotifications();
    });
  }

  requestMtu(): Promise<number> {
    return Promise.reject(
      fail(BleErrorCode.NOT_SUPPORTED, 'The browser negotiates the MTU itself')
    );
  }

  async refreshGattCache(): Promise<boolean> {
    return false;
  }

  readRssi(): Promise<number> {
    return Promise.reject(
      fail(BleErrorCode.NOT_SUPPORTED, "Web Bluetooth doesn't read a connection's RSSI")
    );
  }

  openL2CAPChannel(): Promise<NativeL2CAPChannelPort> {
    return Promise.reject(
      fail(BleErrorCode.NOT_SUPPORTED, "Web Bluetooth doesn't open L2CAP channels")
    );
  }

  async cancelOperation(operationId: number): Promise<void> {
    const stream = this.streams.get(operationId);
    if (stream) stream.cancelled = true;
    const operation = this.cancellable.get(operationId);
    if (operation) this.queue.cancel(operation);
  }

  // Private

  private newQueue(): GattQueue {
    const queue = new GattQueue(this.host.scheduler);
    queue.onSettled = (operation, result, elapsedMs) => {
      const what = [operation.kind, operation.target].filter(Boolean).join(' ');
      const status = result.ok ? 'ok' : `${result.error.code} (${result.error.message})`;
      const when = elapsedMs === null ? 'before it started' : `in ${elapsedMs} ms`;
      this.host.log('debug', `${what}: ${status} ${when}`, this.id, operation.id);
    };
    return queue;
  }

  private startConnect(device: WebBluetoothDevice, options: NativeConnectOptions): void {
    const attempt = ++this.attempt;
    this.watch(device);
    this.setState('connecting');
    const timeoutMs = options.timeoutMs;
    if (timeoutMs !== null) {
      this.cancelConnectTimeout = this.host.scheduler.scheduleAfter(timeoutMs, () => {
        if (attempt !== this.attempt || this.state !== 'connecting') return;
        device.gatt?.disconnect();
        this.finish(
          fail(BleErrorCode.CONNECTION_TIMEOUT, `Connecting timed out after ${timeoutMs} ms`)
        );
      });
    }
    device.gatt!.connect().then(
      async () => {
        if (attempt !== this.attempt || this.state !== 'connecting') return;
        if (options.autoDiscover) {
          try {
            await this.operationWhileConnecting(attempt);
          } catch (error) {
            if (attempt !== this.attempt || this.state !== 'connecting') return;
            device.gatt?.disconnect();
            return this.finish(error as BleError);
          }
          if (attempt !== this.attempt || this.state !== 'connecting') return;
        }
        this.becomeReady();
      },
      (error) => {
        if (attempt !== this.attempt || this.state !== 'connecting') return;
        this.finish(fromWebError(error, { fallback: BleErrorCode.CONNECTION_FAILED }));
      }
    );
  }

  /** autoDiscover runs through the queue before `connected`, inside the connect timeout. */
  private operationWhileConnecting(attempt: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const operation = this.queue.enqueue<Service[]>(
        'discoverServices',
        { timeoutMs: DEFAULT_DISCOVERY_TIMEOUT_MS },
        () => {
          this.readServices(null).then(
            (value) => this.queue.complete({ ok: true, value }, (current) => current === operation),
            (error) =>
              this.queue.complete(
                { ok: false, error: fromWebError(error, { fallback: BleErrorCode.GATT_ERROR }) },
                (current) => current === operation
              )
          );
        },
        (result) => {
          if (attempt !== this.attempt)
            return reject(fail(BleErrorCode.DISCONNECTED, 'Disconnected'));
          if (!result.ok) return reject(result.error);
          this.services = result.value;
          resolve();
        }
      );
    });
  }

  /** Watches the browser's disconnection event; one listener per device. */
  private watch(device: WebBluetoothDevice): void {
    if (this.watched === device) return;
    this.watched = device;
    device.addEventListener('gattserverdisconnected', () => {
      if (this.state === 'connected') {
        this.finish(fail(BleErrorCode.DISCONNECTED, 'The connection was lost'));
      }
    });
  }

  private becomeReady(): void {
    this.cancelConnectTimeout?.();
    this.cancelConnectTimeout = null;
    this.setState('connected');
    const waiters = this.connectWaiters;
    this.connectWaiters = [];
    waiters.forEach((waiter) => waiter.resolve());
  }

  /** Ends the connection or attempt: `error` goes to the state listener, `connectError` to connect(). */
  private finish(error: BleError | null, connectError?: BleError): void {
    this.attempt++;
    this.cancelConnectTimeout?.();
    this.cancelConnectTimeout = null;
    this.services = [];
    this.characteristics.clear();
    this.descriptors.clear();
    for (const id of [...this.batchers.keys()]) {
      this.batchers.get(id)?.flush();
      this.batchers.delete(id);
    }
    this.setState('disconnected', error);
    this.queue.failAll(fail(BleErrorCode.DISCONNECTED, 'Disconnected'));
    this.queue = this.newQueue();
    this.subscriptions.forEach((entry) => this.stopListening(entry));
    this.subscriptions.clear();
    this.subscriptionKeys.clear();
    const failure =
      connectError ??
      error ??
      fail(BleErrorCode.DISCONNECTED, 'Disconnected before the connection was ready');
    const connects = this.connectWaiters;
    this.connectWaiters = [];
    connects.forEach((waiter) => waiter.reject(failure));
  }

  private setState(state: ConnectionState, error?: BleError | null): void {
    if (state === this.state) return;
    this.state = state;
    const event: ConnectionStateEvent = { state };
    if (error) {
      event.code = error.code;
      event.message = error.message;
    }
    this.host.log(
      error ? 'warn' : 'info',
      error ? `${state}: ${error.code} ${error.message}` : state,
      this.id
    );
    this.emitter.emit('connectionStateChange', event);
  }

  /**
   * The services the page may use (those named in the scan) with their characteristics and
   * descriptors; `filter` keeps some. Web Bluetooth only exposes primary services.
   */
  private async readServices(filter: string[] | null): Promise<Service[]> {
    const server = this.host.device(this.id)?.gatt;
    if (!server?.connected) throw fail(BleErrorCode.DISCONNECTED, `Not connected to ${this.id}`);
    const all = await server.getPrimaryServices().catch((error) => {
      if (isNotFound(error)) return [];
      throw error;
    });
    const services: Service[] = [];
    for (const service of all) {
      const serviceUUID = normalizeUUID(service.uuid);
      if (filter && !filter.includes(serviceUUID)) continue;
      if (services.some((known) => known.uuid === serviceUUID)) continue;
      const characteristics = await service.getCharacteristics().catch((error) => {
        if (isNotFound(error)) return [];
        throw error;
      });
      const model: Service = {
        uuid: serviceUUID,
        isPrimary: service.isPrimary !== false,
        characteristics: [],
      };
      for (const characteristic of characteristics) {
        const uuid = normalizeUUID(characteristic.uuid);
        const key = `${serviceUUID}/${uuid}`;
        // A second characteristic with the same UUID can't be addressed (plan §5.4): the first wins.
        if (model.characteristics.some((known) => known.uuid === uuid)) continue;
        this.characteristics.set(key, characteristic);
        const descriptors = await characteristic.getDescriptors().catch(() => []);
        descriptors.forEach((descriptor) =>
          this.descriptors.set(`${key}/${normalizeUUID(descriptor.uuid)}`, descriptor)
        );
        model.characteristics.push({
          uuid,
          serviceUUID,
          properties: properties(characteristic),
          descriptors: descriptors.map((descriptor) => ({
            uuid: normalizeUUID(descriptor.uuid),
            characteristicUUID: uuid,
          })),
        });
      }
      services.push(model);
    }
    return services;
  }

  /** Queues `perform` (plan §4.9); `operationId` lets `cancelOperation` cancel it. */
  private operation<T>(
    kind: GattOperationKind,
    target: {
      characteristic?: string;
      timeoutMs: number;
      operationId?: number | null;
      first?: boolean;
    },
    perform: () => Promise<T>,
    notPermitted?: BleErrorCode
  ): Promise<T> {
    if (this.state !== 'connected') {
      return Promise.reject(fail(BleErrorCode.DISCONNECTED, `Not connected to ${this.id}`));
    }
    const { characteristic, timeoutMs, operationId, first } = target;
    return new Promise((resolve, reject) => {
      const operation = this.queue.enqueue<T>(
        kind,
        { target: characteristic, timeoutMs, first },
        () => {
          perform().then(
            (value) => this.queue.complete({ ok: true, value }, (current) => current === operation),
            (error) =>
              this.queue.complete(
                {
                  ok: false,
                  error: fromWebError(error, { fallback: BleErrorCode.GATT_ERROR, notPermitted }),
                },
                (current) => current === operation
              )
          );
        },
        (result) => {
          if (operationId != null) this.cancellable.delete(operationId);
          return result.ok ? resolve(result.value) : reject(result.error);
        }
      );
      if (operationId != null) this.cancellable.set(operationId, operation);
    });
  }

  private characteristic(
    request: NativeAttributeRequest,
    allowed: CharacteristicProperty[],
    notPermitted: BleErrorCode
  ): WebGattCharacteristic {
    if (this.state !== 'connected')
      throw fail(BleErrorCode.DISCONNECTED, `Not connected to ${this.id}`);
    if (!this.services.some((service) => service.uuid === request.service)) {
      throw fail(
        BleErrorCode.SERVICE_NOT_FOUND,
        `Service ${request.service} not found; discover() it first`
      );
    }
    const characteristic = this.characteristics.get(`${request.service}/${request.characteristic}`);
    if (!characteristic) {
      throw fail(
        BleErrorCode.CHARACTERISTIC_NOT_FOUND,
        `Characteristic ${request.characteristic} not found in ${request.service}`
      );
    }
    if (!allowed.some((property) => properties(characteristic).includes(property))) {
      throw fail(notPermitted, `Characteristic ${request.characteristic} doesn't allow this`);
    }
    return characteristic;
  }

  private writable(request: NativeAttributeRequest): WebGattCharacteristic {
    return this.characteristic(
      request,
      [request.withResponse ? 'write' : 'writeWithoutResponse'],
      BleErrorCode.WRITE_NOT_PERMITTED
    );
  }

  private descriptor(request: NativeAttributeRequest): WebGattDescriptor {
    this.characteristic(request, ALL_PROPERTIES, BleErrorCode.INTERNAL);
    const descriptor = request.descriptor
      ? this.descriptors.get(`${request.service}/${request.characteristic}/${request.descriptor}`)
      : undefined;
    if (!descriptor) {
      throw fail(
        BleErrorCode.DESCRIPTOR_NOT_FOUND,
        `Descriptor ${request.descriptor} not found on ${request.characteristic}`
      );
    }
    return descriptor;
  }

  /** Batched subscribers collect the value (P2-04); the others get it as it comes. */
  private deliver(entry: Subscription, value: Uint8Array): void {
    if (!entry.enabled) return;
    const timestamp = Date.now();
    let unbatched = false;
    entry.subscribers.forEach((id) => {
      const batcher = this.batchers.get(id);
      if (batcher) batcher.add(value, timestamp);
      else unbatched = true;
    });
    if (unbatched) {
      this.emitter.emit('notification', {
        service: entry.service,
        characteristic: entry.uuid,
        value,
        timestamp,
      });
    }
  }

  private stopListening(entry: Subscription): void {
    if (entry.listener)
      entry.characteristic.removeEventListener('characteristicvaluechanged', entry.listener);
    entry.listener = null;
    entry.enabled = false;
  }

  private batcher(subscriptionId: number, spec: NativeBatch): NotificationBatcher {
    return new NotificationBatcher(
      spec.intervalMs,
      spec.maxItems,
      this.host.scheduler,
      () =>
        this.host.warn(
          BleErrorCode.BUFFER_OVERFLOW,
          `Subscription ${subscriptionId} dropped values: more than ${spec.maxItems} arrived within ` +
            `${spec.intervalMs} ms. Later drops are counted in NotificationBatch.dropped`
        ),
      ({ values, timestamps, dropped }) => {
        const all = new Uint8Array(values.reduce((sum, value) => sum + value.length, 0));
        let offset = 0;
        for (const value of values) {
          all.set(value, offset);
          offset += value.length;
        }
        this.emitter.emit('notificationBatch', {
          subscriptionId,
          bytes: all,
          lengths: values.map((value) => value.length),
          timestamps,
          dropped,
        });
      }
    );
  }
}

const ALL_PROPERTIES: CharacteristicProperty[] = [
  'broadcast',
  'read',
  'writeWithoutResponse',
  'write',
  'notify',
  'indicate',
  'authenticatedSignedWrites',
  'extendedProperties',
];

function properties(characteristic: WebGattCharacteristic): CharacteristicProperty[] {
  const p = characteristic.properties;
  const list: [boolean, CharacteristicProperty][] = [
    [p.broadcast, 'broadcast'],
    [p.read, 'read'],
    [p.writeWithoutResponse, 'writeWithoutResponse'],
    [p.write, 'write'],
    [p.notify, 'notify'],
    [p.indicate, 'indicate'],
    [p.authenticatedSignedWrites, 'authenticatedSignedWrites'],
    [p.reliableWrite || p.writableAuxiliaries, 'extendedProperties'],
  ];
  return list.filter(([has]) => has).map(([, name]) => name);
}

function bytes(view: DataView): Uint8Array {
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}

function writeValue(
  characteristic: WebGattCharacteristic,
  value: Uint8Array,
  withResponse: boolean
): Promise<void> {
  if (withResponse && characteristic.writeValueWithResponse) {
    return characteristic.writeValueWithResponse(value);
  }
  if (!withResponse && characteristic.writeValueWithoutResponse) {
    return characteristic.writeValueWithoutResponse(value);
  }
  return characteristic.writeValue(value);
}
