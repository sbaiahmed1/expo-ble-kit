import type { ConnectionStateEvent, NotificationEvent } from './ExpoBleKit.types';
import { BleError, BleErrorCode } from './errors';
import {
  checkValue,
  operationTimeout,
  subscribeMode,
  toNativeAttributeRequest,
  type NativeAttributeRequest,
} from './internal/attributeRequest';
import {
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  toNativeConnectOptions,
  validateMtu,
} from './internal/connectOptions';
import {
  abortedError,
  cancellable,
  checkSignal,
  guard,
  recordError,
  reportListenerError,
  toBleError,
} from './internal/operations';
import type { NativePeripheralPort } from './internal/port';
import type {
  CharacteristicSubscription,
  ConnectionState,
  ConnectOptions,
  OpOptions,
  Peripheral,
  Service,
  SubscribeOptions,
  Subscription,
  WriteOptions,
} from './types';
import { normalizeUUID, type UUID } from './uuid';

let nextSubscriptionId = 1;

/** One subscriber; several share a characteristic's CCCD natively (plan §5.4). */
interface Subscriber {
  service: UUID;
  characteristic: UUID;
  onValue: (value: Uint8Array, timestamp: number) => void;
  subscription: SubscriptionHandle;
}

class SubscriptionHandle implements CharacteristicSubscription {
  active = true;

  constructor(
    private readonly peripheral: PeripheralImpl,
    readonly id: number
  ) {}

  unsubscribe(options?: OpOptions): Promise<void> {
    return this.peripheral.endSubscription(this, options);
  }

  remove(): void {
    // CCCD failures are kept for getDiagnostics(); P2-07 adds the log.
    this.unsubscribe().catch(() => {});
  }
}

/**
 * The public `Peripheral` (plan §5.4) over its native handle. Validates input, applies defaults,
 * wires `AbortSignal`s, fans notifications out to subscribers, and converts errors to `BleError`.
 */
export class PeripheralImpl implements Peripheral {
  private readonly subscribers = new Map<number, Subscriber>();

  constructor(private readonly native: NativePeripheralPort) {
    native.addListener('notification', (event: NotificationEvent) => this.deliver(event));
    native.addListener('connectionStateChange', (event: ConnectionStateEvent) => {
      if (event.code) {
        recordError(this.connectionError(event));
      }
      // Subscriptions end with the connection (plan §4.8); natively they are gone already.
      if (event.state === 'disconnected') {
        this.subscribers.forEach(({ subscription }) => (subscription.active = false));
        this.subscribers.clear();
      }
    });
  }

  get id(): string {
    return this.native.id;
  }

  get name(): string | null {
    return this.native.name ?? null;
  }

  get state(): ConnectionState {
    return this.native.state;
  }

  get mtu(): number {
    return this.native.mtu;
  }

  get services(): Service[] {
    return this.native.services;
  }

  connect(options: ConnectOptions = {}): Promise<void> {
    return guard(async () => {
      const nativeOptions = toNativeConnectOptions(options);
      const signal = checkSignal(options.signal);
      if (signal?.aborted) {
        throw abortedError();
      }
      // Aborting cancels the attempt the way disconnect() does: connect rejects OPERATION_CANCELLED.
      const onAbort = () => {
        this.native.disconnect().catch(() => {});
      };
      signal?.addEventListener('abort', onAbort);
      try {
        await this.native.connect(nativeOptions);
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    }, this.context());
  }

  disconnect(): Promise<void> {
    return guard(() => this.native.disconnect(), this.context());
  }

  discover(services?: UUID[], options?: OpOptions): Promise<Service[]> {
    return guard(() => {
      if (services !== undefined && !Array.isArray(services)) {
        throw invalid('services', 'expected an array of UUIDs');
      }
      const filter = services && [...new Set(services.map((uuid) => normalizeUUID(uuid)))];
      const timeoutMs = operationTimeout(options, DEFAULT_DISCOVERY_TIMEOUT_MS);
      return this.cancellable(options, (operationId) =>
        this.native.discover(filter ?? null, timeoutMs, operationId)
      );
    }, this.context());
  }

  read(service: UUID, characteristic: UUID, options?: OpOptions): Promise<Uint8Array> {
    return this.attribute(service, characteristic, undefined, options, (request) =>
      this.native.read(request)
    );
  }

  write(
    service: UUID,
    characteristic: UUID,
    value: Uint8Array,
    options?: WriteOptions
  ): Promise<void> {
    return this.attribute(service, characteristic, undefined, options, (request) =>
      this.native.write(request, checkValue(value))
    );
  }

  readDescriptor(
    service: UUID,
    characteristic: UUID,
    descriptor: UUID,
    options?: OpOptions
  ): Promise<Uint8Array> {
    return this.attribute(service, characteristic, descriptor, options, (request) =>
      this.native.readDescriptor(request)
    );
  }

  writeDescriptor(
    service: UUID,
    characteristic: UUID,
    descriptor: UUID,
    value: Uint8Array,
    options?: OpOptions
  ): Promise<void> {
    return this.attribute(service, characteristic, descriptor, options, (request) =>
      this.native.writeDescriptor(request, checkValue(value))
    );
  }

  subscribe(
    service: UUID,
    characteristic: UUID,
    onValue: (value: Uint8Array, timestamp: number) => void,
    options: SubscribeOptions = {}
  ): Promise<CharacteristicSubscription> {
    return guard(
      async () => {
        if (typeof onValue !== 'function') {
          throw invalid('onValue', 'expected a function');
        }
        const request = toNativeAttributeRequest(service, characteristic, undefined, options);
        const mode = subscribeMode(options);
        const signal = checkSignal(options.signal);
        if (signal?.aborted) {
          throw abortedError();
        }
        const id = nextSubscriptionId++;
        const subscription = new SubscriptionHandle(this, id);
        // Registered first: a value can arrive before the native call resolves.
        this.subscribers.set(id, {
          service: request.service,
          characteristic: request.characteristic,
          onValue,
          subscription,
        });
        // Aborting removes this subscriber natively, which rejects the pending subscribe.
        const onAbort = () => {
          this.native.unsubscribe(id, request.timeoutMs).catch(() => {});
        };
        signal?.addEventListener('abort', onAbort);
        try {
          await this.native.subscribe(request, id, mode);
          return subscription;
        } catch (error) {
          this.subscribers.delete(id);
          subscription.active = false;
          throw error;
        } finally {
          signal?.removeEventListener('abort', onAbort);
        }
      },
      this.context(service, characteristic)
    );
  }

  /**
   * Delivery stops at once. The CCCD write (when this was the last subscriber) runs even if
   * `signal` aborts: abandoning it would leave notifications on.
   */
  endSubscription(subscription: SubscriptionHandle, options: OpOptions = {}): Promise<void> {
    const entry = this.subscribers.get(subscription.id);
    const context = this.context(entry?.service, entry?.characteristic);
    return guard(async () => {
      if (!subscription.active) {
        return;
      }
      const timeoutMs = operationTimeout(options);
      const signal = checkSignal(options.signal);
      subscription.active = false;
      this.subscribers.delete(subscription.id);
      const done = this.native.unsubscribe(subscription.id, timeoutMs).catch((error) => {
        throw toBleError(error, context);
      });
      if (!signal) {
        return done;
      }
      done.catch(() => {}); // Recorded above; the caller stopped waiting.
      return abortable(done, signal);
    }, context);
  }

  readRssi(options?: OpOptions): Promise<number> {
    return guard(() => {
      const timeoutMs = operationTimeout(options);
      return this.cancellable(options, (operationId) =>
        this.native.readRssi(timeoutMs, operationId)
      );
    }, this.context());
  }

  requestMtu(mtu: number, options?: OpOptions): Promise<number> {
    return guard(() => {
      const value = validateMtu('mtu', mtu);
      const timeoutMs = operationTimeout(options);
      return this.cancellable(options, (operationId) =>
        this.native.requestMtu(value, timeoutMs, operationId)
      );
    }, this.context());
  }

  addConnectionStateListener(
    listener: (state: ConnectionState, error?: BleError) => void
  ): Subscription {
    if (typeof listener !== 'function') {
      throw invalid('listener', 'expected a function');
    }
    return this.native.addListener('connectionStateChange', (event: ConnectionStateEvent) =>
      listener(event.state, event.code ? this.connectionError(event) : undefined)
    );
  }

  // Private

  private attribute<T>(
    service: UUID,
    characteristic: UUID,
    descriptor: UUID | undefined,
    options: WriteOptions | undefined,
    run: (request: NativeAttributeRequest) => Promise<T>
  ): Promise<T> {
    return guard(
      () => {
        const request = toNativeAttributeRequest(service, characteristic, descriptor, options);
        return this.cancellable(options, (operationId) =>
          run(operationId === null ? request : { ...request, operationId })
        );
      },
      this.context(service, characteristic)
    );
  }

  private cancellable<T>(
    options: OpOptions | undefined,
    start: (operationId: number | null) => Promise<T>
  ): Promise<T> {
    return cancellable(checkSignal(options?.signal), start, (operationId) => {
      this.native.cancelOperation(operationId).catch(() => {});
    });
  }

  private deliver(event: NotificationEvent): void {
    this.subscribers.forEach((subscriber) => {
      if (
        subscriber.service === event.service &&
        subscriber.characteristic === event.characteristic
      ) {
        try {
          subscriber.onValue(event.value, event.timestamp);
        } catch (error) {
          reportListenerError(error);
        }
      }
    });
  }

  private connectionError(event: ConnectionStateEvent): BleError {
    return BleError.fromNative(
      { code: event.code, message: event.message ?? `Connection ${event.state}` },
      { peripheralId: this.id }
    );
  }

  private context(service?: UUID, characteristic?: UUID) {
    return {
      peripheralId: this.native.id,
      ...(service !== undefined && { serviceUUID: safeUUID(service) }),
      ...(characteristic !== undefined && { characteristicUUID: safeUUID(characteristic) }),
    };
  }
}

/** Resolves or rejects with `promise`, or rejects with OPERATION_CANCELLED when `signal` aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortedError());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortedError());
    signal.addEventListener('abort', onAbort);
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** For error context only: the input as given when it isn't a valid UUID. */
function safeUUID(input: UUID): string {
  try {
    return normalizeUUID(input);
  } catch {
    return String(input);
  }
}

function invalid(option: string, problem: string): BleError {
  return new BleError(BleErrorCode.INVALID_ARGUMENT, `Invalid ${option}: ${problem}`);
}
