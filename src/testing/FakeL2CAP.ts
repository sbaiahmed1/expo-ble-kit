import type { L2CAPChannelObjectEvents, L2CAPServerObjectEvents } from '../ExpoBleKit.types';
import { BleError, BleErrorCode } from '../errors';
import type { NativeL2CAPChannelPort, NativeL2CAPServerPort } from '../internal/port';
import type { Scheduler } from '../internal/scheduler';
import type { Subscription } from '../types';
import { Emitter } from './Emitter';

/** The other end of an L2CAP channel in the fake (P5-03): a virtual peripheral's or a central's. */
export interface VirtualL2CAPChannel {
  /** The channel's PSM. */
  readonly psm: number;
  /** False once either side closed the channel. */
  readonly isOpen: boolean;
  /** What the app wrote, one entry per `write`, oldest first. */
  readonly received: readonly Uint8Array[];
  /** Sends bytes to the app, which gets them once it has a data listener. */
  write(data: Uint8Array): void;
  /** Called with each write of the app; replaces the previous handler. */
  onData(handler: ((data: Uint8Array) => void) | null): void;
  /** Closes the channel from this side: the app's close listener hears no error. */
  close(): void;
}

/**
 * Both ends of one channel (plan §5.5 L2CAP rules): bytes reach the other end on later ticks, the
 * app's end reads only once JS asked it to, and a close reaches both ends once.
 */
export class FakeL2CAPLink {
  readonly app: NativeL2CAPChannelPort;
  readonly peer: VirtualL2CAPChannel;
  private open = true;
  private receiving = false;
  private closeError: BleError | null = null;
  private readonly inbound: Uint8Array[] = [];
  private readonly received: Uint8Array[] = [];
  private handler: ((data: Uint8Array) => void) | null = null;
  private readonly emitter = new Emitter<L2CAPChannelObjectEvents>();

  constructor(
    readonly psm: number,
    readonly peerId: string,
    private readonly scheduler: Scheduler,
    private readonly onClosed: (link: FakeL2CAPLink) => void
  ) {
    const link = this;
    this.app = {
      psm,
      peerId,
      get isOpen() {
        return link.open;
      },
      write: (data) => this.appWrite(data),
      receive: () => {
        this.receiving = true;
        this.scheduler.schedule(() => this.drain());
      },
      close: async () => this.close(null),
      addListener: (event, listener) => this.emitter.addListener(event, listener),
    };
    this.peer = {
      psm,
      get isOpen() {
        return link.open;
      },
      received: this.received,
      write: (data) => {
        if (!this.open) throw new Error(`L2CAP channel ${psm} is closed`);
        this.inbound.push(data.slice());
        this.scheduler.schedule(() => this.drain());
      },
      onData: (handler) => {
        this.handler = handler;
      },
      close: () => this.close(null),
    };
  }

  /** Closes both ends; `error` is what the app's close listener hears, null when a side closed it. */
  close(error: BleError | null): void {
    if (!this.open) return;
    this.open = false;
    this.closeError = error;
    this.inbound.length = 0;
    this.emitter.emit('close', error ? { code: error.code, message: error.message } : {});
    this.onClosed(this);
  }

  private appWrite(data: Uint8Array): Promise<void> {
    if (!this.open) return Promise.reject(this.writeError());
    const bytes = data.slice();
    return new Promise((resolve, reject) =>
      this.scheduler.schedule(() => {
        if (!this.open) return reject(this.writeError());
        this.received.push(bytes);
        this.handler?.(bytes);
        resolve();
      })
    );
  }

  private writeError(): BleError {
    return (
      this.closeError ?? new BleError(BleErrorCode.L2CAP_FAILED, `L2CAP channel ${this.psm} closed`)
    );
  }

  private drain(): void {
    while (this.open && this.receiving && this.inbound.length > 0) {
      this.emitter.emit('data', { data: this.inbound.shift()! });
    }
  }
}

/** The app's L2CAP server in the fake (P5-03). Closing it closes its channels. */
export class FakeL2CAPServer implements NativeL2CAPServerPort {
  private readonly emitter = new Emitter<L2CAPServerObjectEvents>();
  private readonly links = new Set<FakeL2CAPLink>();
  private readonly announced = new Map<number, FakeL2CAPLink>();
  private nextChannelId = 1;
  private open = true;

  constructor(
    readonly psm: number,
    private readonly scheduler: Scheduler,
    private readonly onClosed: (server: FakeL2CAPServer) => void
  ) {}

  get isOpen(): boolean {
    return this.open;
  }

  /** A central opens a channel: the app hears of it on a later tick, as a `channel` event. */
  accept(centralId: string): Promise<VirtualL2CAPChannel> {
    const link = new FakeL2CAPLink(this.psm, centralId, this.scheduler, (closed) => {
      this.links.delete(closed);
    });
    this.links.add(link);
    return new Promise((resolve) =>
      this.scheduler.schedule(() => {
        if (this.open && link.app.isOpen) {
          const channelId = this.nextChannelId++;
          this.announced.set(channelId, link);
          this.emitter.emit('channel', { channelId });
        }
        resolve(link.peer);
      })
    );
  }

  takeChannel(channelId: number): NativeL2CAPChannelPort | null {
    const link = this.announced.get(channelId);
    this.announced.delete(channelId);
    return link?.app.isOpen ? link.app : null;
  }

  async close(): Promise<void> {
    this.shut(null);
  }

  /** Ends the server and its channels; `error` goes to the channels' close listeners. */
  shut(error: BleError | null): void {
    if (!this.open) return;
    this.open = false;
    this.announced.clear();
    [...this.links].forEach((link) => link.close(error));
    this.onClosed(this);
  }

  addListener<E extends keyof L2CAPServerObjectEvents>(
    event: E,
    listener: L2CAPServerObjectEvents[E]
  ): Subscription {
    return this.emitter.addListener(event, listener);
  }
}
