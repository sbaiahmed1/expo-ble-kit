import type { ServerRequestEvent, SubscriptionChangeEvent } from './ExpoBleKit.types';
import { BleError, BleErrorCode } from './errors';
import { AttError, attErrorFor, MAX_VALUE_LENGTH } from './internal/gattServer';
import { log } from './internal/log';
import type { NativeGattServerPort } from './internal/port';
import type { GattServer, ReadRequest, Subscription, WriteRequest } from './types';
import { normalizeUUID, type UUID } from './uuid';

type ReadHandler = (request: ReadRequest) => Uint8Array | Promise<Uint8Array>;
type WriteHandler = (request: WriteRequest) => void | Promise<void>;
type SubscriptionListener = (event: {
  centralId: string;
  characteristic: UUID;
  subscribed: boolean;
}) => void;

/**
 * The JS side of the GATT server (plan §5.5, P4-01): runs the app's handlers for the native
 * server's requests and answers each request once, by id. The native core slices read values for
 * offsets, caches them for long reads and answers requests the app leaves past the deadline.
 */
export class GattServerImpl implements GattServer {
  private readHandler: ReadHandler | null = null;
  private writeHandler: WriteHandler | null = null;
  private readonly subscriptionListeners = new Set<SubscriptionListener>();
  private readonly nativeListeners: Subscription[];
  private closed = false;

  constructor(private readonly native: NativeGattServerPort) {
    this.nativeListeners = [
      native.addListener('readRequest', (event) => this.read(event)),
      native.addListener('writeRequest', (event) => this.write(event)),
      native.addListener('subscriptionChange', (event) => this.subscription(event)),
    ];
  }

  onReadRequest(handler: ReadHandler): Subscription {
    if (typeof handler !== 'function') throw invalidHandler();
    this.readHandler = handler;
    return { remove: () => this.readHandler === handler && (this.readHandler = null) };
  }

  onWriteRequest(handler: WriteHandler): Subscription {
    if (typeof handler !== 'function') throw invalidHandler();
    this.writeHandler = handler;
    return { remove: () => this.writeHandler === handler && (this.writeHandler = null) };
  }

  addSubscriptionListener(listener: SubscriptionListener): Subscription {
    if (typeof listener !== 'function') throw invalidHandler();
    this.subscriptionListeners.add(listener);
    return { remove: () => this.subscriptionListeners.delete(listener) };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.nativeListeners.forEach((listener) => listener.remove());
    this.readHandler = null;
    this.writeHandler = null;
    this.subscriptionListeners.clear();
    await this.native.close();
  }

  private async read(event: ServerRequestEvent): Promise<void> {
    const handler = this.readHandler;
    if (!handler)
      return this.native.respondToRead(event.requestId, null, AttError.READ_NOT_PERMITTED);
    const request: ReadRequest = {
      centralId: event.centralId,
      characteristic: normalizeUUID(event.characteristic),
      offset: event.offset,
    };
    try {
      const value = await handler(request);
      if (!(value instanceof Uint8Array)) {
        throw new BleError(
          BleErrorCode.INVALID_ARGUMENT,
          'The read handler must return a Uint8Array'
        );
      }
      if (value.length > MAX_VALUE_LENGTH) {
        throw new BleError(
          BleErrorCode.INVALID_ATTRIBUTE_LENGTH,
          `The read handler returned ${value.length} bytes; a value has at most ${MAX_VALUE_LENGTH}`
        );
      }
      this.native.respondToRead(event.requestId, value, null);
    } catch (error) {
      report('read', request.characteristic, error);
      this.native.respondToRead(event.requestId, null, attErrorFor(error));
    }
  }

  private async write(event: ServerRequestEvent): Promise<void> {
    const handler = this.writeHandler;
    if (!handler) return this.native.respondToWrite(event.requestId, AttError.WRITE_NOT_PERMITTED);
    const request: WriteRequest = {
      centralId: event.centralId,
      characteristic: normalizeUUID(event.characteristic),
      offset: event.offset,
      value: event.value ?? new Uint8Array(0),
      withResponse: event.withResponse ?? true,
    };
    try {
      await handler(request);
      this.native.respondToWrite(event.requestId, null);
    } catch (error) {
      report('write', request.characteristic, error);
      this.native.respondToWrite(event.requestId, attErrorFor(error));
    }
  }

  private subscription(event: SubscriptionChangeEvent): void {
    const change = { ...event, characteristic: normalizeUUID(event.characteristic) };
    for (const listener of [...this.subscriptionListeners]) {
      try {
        listener(change);
      } catch (error) {
        log('error', `A GATT server subscription listener threw: ${String(error)}`);
      }
    }
  }
}

function invalidHandler(): BleError {
  return new BleError(BleErrorCode.INVALID_ARGUMENT, 'Expected a function');
}

/** A refusal with a BleError code is the app's answer; anything else is a bug worth a log line. */
function report(kind: 'read' | 'write', characteristic: UUID, error: unknown): void {
  if (error instanceof BleError && error.code !== BleErrorCode.INVALID_ARGUMENT) return;
  log('warn', `The ${kind} handler for ${characteristic} failed: ${String(error)}`);
}
