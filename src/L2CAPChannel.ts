import type { L2CAPCloseEvent } from './ExpoBleKit.types';
import { BleError, BleErrorCode } from './errors';
import { log } from './internal/log';
import { guard, recordError, reportListenerError } from './internal/operations';
import type { NativeL2CAPChannelPort, NativeL2CAPServerPort } from './internal/port';
import type { L2CAPChannel, L2CAPServer, Subscription } from './types';

/** The LE PSM range (Core spec Vol 3 Part A 4.22); the systems assign dynamic PSMs from 0x80. */
const MIN_PSM = 1;
const MAX_PSM = 255;

/** `openL2CAPChannel` default: a secure channel may wait for the user to accept pairing. */
export const L2CAP_OPEN_TIMEOUT_MS = 30_000;

export function validatePsm(psm: unknown): number {
  if (typeof psm !== 'number' || !Number.isInteger(psm) || psm < MIN_PSM || psm > MAX_PSM) {
    throw new BleError(
      BleErrorCode.INVALID_ARGUMENT,
      `Invalid PSM: expected an integer from ${MIN_PSM} to ${MAX_PSM}`
    );
  }
  return psm;
}

/** `secure` from the options: a boolean, true when left out. */
export function validateSecure(option: string, value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'boolean') {
    throw new BleError(BleErrorCode.INVALID_ARGUMENT, `Invalid ${option}: expected a boolean`);
  }
  return value;
}

/**
 * The public `L2CAPChannel` (plan §5.4, P5-03) over its native handle. Reading starts natively with
 * the first data listener; the close listeners run once, whatever closed the channel.
 */
export class L2CAPChannelImpl implements L2CAPChannel {
  private readonly dataListeners = new Set<(data: Uint8Array) => void>();
  private readonly closeListeners = new Set<(error?: BleError) => void>();
  private readonly nativeListeners: Subscription[];
  private receiving = false;
  private closed = false;

  constructor(private readonly native: NativeL2CAPChannelPort) {
    this.nativeListeners = [
      native.addListener('data', (event) => this.deliver(event.data)),
      native.addListener('close', (event) => this.end(event)),
    ];
    // It may have closed before JS subscribed; the reason went with the missed event.
    if (!native.isOpen) this.end({});
  }

  get psm(): number {
    return this.native.psm;
  }

  get peerId(): string {
    return this.native.peerId;
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  write(data: Uint8Array): Promise<void> {
    return guard(async () => {
      if (!(data instanceof Uint8Array)) {
        throw new BleError(BleErrorCode.INVALID_ARGUMENT, 'Invalid data: expected a Uint8Array');
      }
      if (this.closed) throw closedError();
      if (data.length === 0) return;
      await this.native.write(data);
    }, this.context());
  }

  addDataListener(listener: (data: Uint8Array) => void): Subscription {
    checkListener(listener);
    this.dataListeners.add(listener);
    if (!this.receiving && !this.closed) {
      this.receiving = true;
      this.native.receive();
    }
    return { remove: () => this.dataListeners.delete(listener) };
  }

  addCloseListener(listener: (error?: BleError) => void): Subscription {
    checkListener(listener);
    if (!this.closed) this.closeListeners.add(listener);
    return { remove: () => this.closeListeners.delete(listener) };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await guard(() => this.native.close(), this.context());
    this.end({});
  }

  private deliver(data: Uint8Array): void {
    for (const listener of [...this.dataListeners]) {
      try {
        listener(data);
      } catch (error) {
        reportListenerError(error);
      }
    }
  }

  private end(event: L2CAPCloseEvent): void {
    if (this.closed) return;
    this.closed = true;
    this.nativeListeners.forEach((subscription) => subscription.remove());
    this.dataListeners.clear();
    const error = event.code
      ? recordError(
          BleError.fromNative(
            { code: event.code, message: event.message ?? 'The L2CAP channel closed' },
            this.context()
          )
        )
      : undefined;
    const listeners = [...this.closeListeners];
    this.closeListeners.clear();
    for (const listener of listeners) {
      try {
        listener(error);
      } catch (thrown) {
        reportListenerError(thrown);
      }
    }
  }

  private context() {
    return { peripheralId: this.native.peerId };
  }
}

/** The public `L2CAPServer` (plan §5.5, P5-03): takes each announced channel and hands it out. */
export class L2CAPServerImpl implements L2CAPServer {
  private readonly listeners = new Set<(channel: L2CAPChannel) => void>();
  private readonly nativeListener: Subscription;
  private closed = false;

  constructor(private readonly native: NativeL2CAPServerPort) {
    this.nativeListener = native.addListener('channel', ({ channelId }) => this.accept(channelId));
  }

  get psm(): number {
    return this.native.psm;
  }

  addChannelListener(listener: (channel: L2CAPChannel) => void): Subscription {
    checkListener(listener);
    this.listeners.add(listener);
    return { remove: () => this.listeners.delete(listener) };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.nativeListener.remove();
    this.listeners.clear();
    await guard(() => this.native.close());
  }

  private accept(channelId: number): void {
    const port = this.native.takeChannel(channelId);
    if (!port) return;
    const channel = new L2CAPChannelImpl(port);
    if (this.listeners.size === 0) {
      log('warn', `L2CAP server ${this.psm}: closed a channel from ${port.peerId}, no listener`);
      channel.close().catch(() => {});
      return;
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(channel);
      } catch (error) {
        reportListenerError(error);
      }
    }
  }
}

function checkListener(listener: unknown): void {
  if (typeof listener !== 'function') {
    throw new BleError(BleErrorCode.INVALID_ARGUMENT, 'Invalid listener: expected a function');
  }
}

function closedError(): BleError {
  return new BleError(BleErrorCode.L2CAP_FAILED, 'The L2CAP channel is closed');
}
