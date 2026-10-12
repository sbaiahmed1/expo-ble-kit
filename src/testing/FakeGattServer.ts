import type { GattServerObjectEvents } from '../ExpoBleKit.types';
import { BleError, BleErrorCode } from '../errors';
import { Emitter } from '../internal/emitter';
import {
  AttError,
  codeForAttError,
  MAX_VALUE_LENGTH,
  type NativeServiceDefinition,
  ServerReadCache,
} from '../internal/gattServer';
import type { NativeGattServerPort } from '../internal/port';
import type { Scheduler } from '../internal/scheduler';
import type { Subscription } from '../types';
import { normalizeUUID, type UUID } from '../uuid';

/** JS must answer before this, like the native cores (plan §5.5). */
const RESPONSE_DEADLINE_MS = 25_000;
const OK = 0;

type Definition = NativeServiceDefinition['characteristics'][number];
type Answer = { status: number; value?: Uint8Array };

/** A central connected to the fake GATT server (`FakeBle.connectCentral`), reading and writing like a real one. */
export interface VirtualCentral {
  /** The id the server's handlers see as `centralId`. */
  readonly id: string;
  /** Reads like a central: a Read, then Read Blobs of MTU − 1 bytes until a shorter answer. */
  read(characteristic: UUID): Promise<Uint8Array>;
  /**
   * Writes like a central: one Write Request, or prepared writes and an execute when the value
   * doesn't fit one packet (MTU − 3). Without response the value must fit one packet.
   */
  write(
    characteristic: UUID,
    value: Uint8Array,
    options?: { withResponse?: boolean }
  ): Promise<void>;
  /** Writes the CCCD: notifications, or indications with `mode: 'indicate'`. */
  subscribe(characteristic: UUID, mode?: 'notify' | 'indicate'): Promise<void>;
  /** Writes the CCCD off. */
  unsubscribe(characteristic: UUID): Promise<void>;
  /** Drops the link: the server forgets the central's subscriptions and cached reads. */
  disconnect(): void;
  /** What the server sent this central (P4-02), oldest first. */
  readonly notifications: readonly {
    /** The characteristic it was sent for. */
    characteristic: UUID;
    /** The value, as sent. */
    value: Uint8Array;
    /** True for an indication (the central subscribed with `mode: 'indicate'`). */
    indication: boolean;
  }[];
}

/**
 * The fake GATT server (P4-01), following the native cores: static values answered without JS,
 * dynamic reads and writes sent to JS with a 25 s deadline, long reads from the shared read cache
 * (test-contracts/gatt-server-reads.json), long writes as one value per characteristic at execute,
 * and subscriptions through the CCCD. Answers reach the central on later ticks.
 */
export class FakeGattServer implements NativeGattServerPort {
  private readonly emitter = new Emitter<GattServerObjectEvents>();
  private readonly characteristics = new Map<UUID, Definition>();
  private readonly cache: ServerReadCache;
  private readonly pending = new Map<
    number,
    {
      isRead: boolean;
      central: string;
      characteristic: UUID;
      offset: number;
      answer: (a: Answer) => void;
      cancel: () => void;
    }
  >();
  private readonly prepared = new Map<
    string,
    { characteristic: UUID; offset: number; value: Uint8Array }[]
  >();
  private readonly subscribers = new Map<UUID, Map<string, number>>();
  /** Per central: its MTU, what it received, and the notifications not yet delivered (one at a time). */
  private readonly centrals = new Map<
    string,
    {
      mtu: number;
      received: VirtualCentral['notifications'][number][];
      outbox: (() => void)[];
      sending: boolean;
    }
  >();
  private nextRequestId = 1;
  closed = false;

  constructor(
    services: NativeServiceDefinition[],
    private readonly scheduler: Scheduler,
    private readonly warn: (code: BleErrorCode, message: string) => void,
    private readonly onClose: () => void
  ) {
    services.forEach((service) =>
      service.characteristics.forEach((c) => this.characteristics.set(c.uuid, c))
    );
    this.cache = new ServerReadCache(() => scheduler.now());
  }

  // NativeGattServerPort

  respondToRead(requestId: number, value: Uint8Array | null, attError: number | null): void {
    const request = this.pending.get(requestId);
    if (!request?.isRead) return;
    this.pending.delete(requestId);
    request.cancel();
    if (attError !== null || value === null) {
      return request.answer({ status: attError ?? AttError.UNLIKELY_ERROR });
    }
    this.cache.store(request.central, request.characteristic, value);
    request.answer(slice(value, request.offset));
  }

  respondToWrite(requestId: number, attError: number | null): void {
    const request = this.pending.get(requestId);
    if (!request || request.isRead) return;
    this.pending.delete(requestId);
    request.cancel();
    request.answer({ status: attError ?? OK });
  }

  async notify(characteristic: string, value: Uint8Array, only: string[] | null): Promise<void> {
    const uuid = normalizeUUID(characteristic);
    const definition = this.characteristics.get(uuid);
    if (this.closed) throw new BleError(BleErrorCode.DISCONNECTED, 'The GATT server is closed');
    if (!definition)
      throw new BleError(
        BleErrorCode.CHARACTERISTIC_NOT_FOUND,
        `No characteristic ${uuid} on the server`
      );
    if (!definition.properties.some((p) => p === 'notify' || p === 'indicate')) {
      throw new BleError(BleErrorCode.NOT_SUPPORTED, `${uuid} doesn't notify or indicate`);
    }
    const targets = [...(this.subscribers.get(uuid) ?? [])].filter(
      ([id]) => !only || only.includes(id)
    );
    for (const [id] of targets) {
      const limit = (this.centrals.get(id)?.mtu ?? 23) - 3;
      if (value.length > limit) {
        throw new BleError(
          BleErrorCode.INVALID_ATTRIBUTE_LENGTH,
          `A notification to ${id} takes at most ${limit} bytes (MTU − 3), got ${value.length}`
        );
      }
    }
    // Like the native cores: one notification in flight per central, each delivered on a later tick.
    await Promise.all(
      targets.map(
        ([id, mode]) =>
          new Promise<void>((done, fail) => {
            const central = this.centrals.get(id);
            if (!central) return done();
            central.outbox.push(() => {
              if (this.closed) {
                return fail(
                  new BleError(
                    BleErrorCode.DISCONNECTED,
                    'The GATT server closed before the notification was sent'
                  )
                );
              }
              if (this.subscribers.get(uuid)?.has(id)) {
                central.received.push({
                  characteristic: uuid,
                  value: value.slice(),
                  indication: mode === 2,
                });
              }
              done();
            });
            this.pump(central);
          })
      )
    );
  }

  private pump(central: { outbox: (() => void)[]; sending: boolean }): void {
    if (central.sending) return;
    const next = central.outbox.shift();
    if (!next) return;
    central.sending = true;
    this.scheduler.schedule(() => {
      central.sending = false;
      next();
      this.pump(central);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.pending.forEach((request) => request.cancel());
    this.pending.clear();
    for (const central of this.centrals.values())
      central.outbox.splice(0).forEach((send) => send());
    this.onClose();
  }

  addListener<E extends keyof GattServerObjectEvents>(
    event: E,
    listener: GattServerObjectEvents[E]
  ): Subscription {
    return this.emitter.addListener(event, listener);
  }

  // The central side

  connect(id: string, mtu: number): VirtualCentral {
    const server = this;
    const state = {
      mtu,
      received: [] as VirtualCentral['notifications'][number][],
      outbox: [] as (() => void)[],
      sending: false,
    };
    this.centrals.set(id, state);
    const later = <T>(work: () => T | Promise<T>) =>
      new Promise<T>((resolve, reject) =>
        server.scheduler.schedule(() => Promise.resolve().then(work).then(resolve, reject))
      );
    const known = (characteristic: UUID) => {
      const uuid = normalizeUUID(characteristic);
      if (server.closed) throw new BleError(BleErrorCode.DISCONNECTED, 'The GATT server is closed');
      if (!server.characteristics.has(uuid)) {
        throw new BleError(
          BleErrorCode.CHARACTERISTIC_NOT_FOUND,
          `No characteristic ${uuid} on the server`
        );
      }
      return uuid;
    };
    const check = (answer: Answer, what: string) => {
      if (answer.status !== OK) {
        throw new BleError(
          codeForAttError(answer.status),
          `${what} failed with ATT error 0x${answer.status.toString(16)}`
        );
      }
      return answer.value ?? new Uint8Array(0);
    };
    return {
      id,
      read: (characteristic) =>
        later(async () => {
          const uuid = known(characteristic);
          const parts: number[] = [];
          for (let offset = 0; ;) {
            const part = check(await server.readAt(id, uuid, offset), `Reading ${uuid}`).slice(
              0,
              mtu - 1
            );
            parts.push(...part);
            if (part.length < mtu - 1) return Uint8Array.from(parts);
            offset += part.length;
          }
        }),
      write: (characteristic, value, options) =>
        later(async () => {
          const uuid = known(characteristic);
          const withResponse = options?.withResponse ?? true;
          if (value.length <= mtu - 3 || !withResponse) {
            if (value.length > mtu - 3) {
              throw new BleError(
                BleErrorCode.INVALID_ATTRIBUTE_LENGTH,
                `A write without response takes at most ${mtu - 3} bytes`
              );
            }
            check(await server.write(id, uuid, value, withResponse), `Writing ${uuid}`);
            return;
          }
          for (let offset = 0; offset < value.length; offset += mtu - 5) {
            server.prepare(id, uuid, offset, value.slice(offset, offset + mtu - 5));
          }
          check(await server.execute(id), `Writing ${uuid}`);
        }),
      subscribe: (characteristic, mode = 'notify') =>
        later(() => {
          check(
            { status: server.writeCccd(id, known(characteristic), mode === 'indicate' ? 2 : 1) },
            'Subscribing'
          );
        }),
      unsubscribe: (characteristic) =>
        later(() => {
          check({ status: server.writeCccd(id, known(characteristic), 0) }, 'Unsubscribing');
        }),
      disconnect: () => server.disconnectCentral(id),
      get notifications() {
        return state.received;
      },
    };
  }

  private ask(
    isRead: boolean,
    central: string,
    characteristic: UUID,
    offset: number,
    event: object
  ): Promise<Answer> {
    return new Promise((answer) => {
      const requestId = this.nextRequestId++;
      const cancel = this.scheduler.scheduleAfter(RESPONSE_DEADLINE_MS, () => {
        if (!this.pending.has(requestId)) return;
        this.warn(
          BleErrorCode.OPERATION_TIMEOUT,
          `The ${isRead ? 'read' : 'write'} request for ${characteristic} wasn't answered within ` +
            `${RESPONSE_DEADLINE_MS} ms; the server answered with an ATT error`
        );
        if (isRead) this.respondToRead(requestId, null, AttError.UNLIKELY_ERROR);
        else this.respondToWrite(requestId, AttError.UNLIKELY_ERROR);
      });
      this.pending.set(requestId, { isRead, central, characteristic, offset, answer, cancel });
      const payload = { requestId, centralId: central, characteristic, offset, ...event };
      this.emitter.emit(isRead ? 'readRequest' : 'writeRequest', payload);
    });
  }

  /** One Read or Read Blob at `offset` (used by `VirtualCentral` and the shared contract test). */
  async readAt(central: string, uuid: UUID, offset: number): Promise<Answer> {
    const definition = this.characteristics.get(uuid)!;
    if (!definition.properties.includes('read')) return { status: AttError.READ_NOT_PERMITTED };
    if (definition.value) return slice(definition.value, offset);
    const cached = this.cache.lookup(central, uuid, offset);
    if (cached) return slice(cached, offset);
    return this.ask(true, central, uuid, offset, {});
  }

  private async write(
    central: string,
    uuid: UUID,
    value: Uint8Array,
    withResponse: boolean
  ): Promise<Answer> {
    const definition = this.characteristics.get(uuid)!;
    const allowed = definition.properties.includes(withResponse ? 'write' : 'writeWithoutResponse');
    if (definition.value || !allowed) return { status: AttError.WRITE_NOT_PERMITTED };
    const answer = this.ask(false, central, uuid, 0, { value, withResponse });
    return withResponse ? answer : { status: OK };
  }

  private prepare(central: string, characteristic: UUID, offset: number, value: Uint8Array): void {
    const parts = this.prepared.get(central) ?? [];
    parts.push({ characteristic, offset, value });
    this.prepared.set(central, parts);
  }

  private async execute(central: string): Promise<Answer> {
    const parts = this.prepared.get(central) ?? [];
    this.prepared.delete(central);
    const values = new Map<UUID, number[]>();
    for (const { characteristic, offset, value } of parts) {
      const definition = this.characteristics.get(characteristic)!;
      if (definition.value || !definition.properties.includes('write'))
        return { status: AttError.WRITE_NOT_PERMITTED };
      const current = values.get(characteristic) ?? [];
      if (offset > current.length) return { status: AttError.INVALID_OFFSET };
      if (offset + value.length > MAX_VALUE_LENGTH)
        return { status: AttError.INVALID_ATTRIBUTE_LENGTH };
      current.splice(offset, value.length, ...value);
      values.set(characteristic, current);
    }
    const answers = await Promise.all(
      [...values].map(([uuid, bytes]) =>
        this.ask(false, central, uuid, 0, { value: Uint8Array.from(bytes), withResponse: true })
      )
    );
    return answers.find((answer) => answer.status !== OK) ?? { status: OK };
  }

  private writeCccd(central: string, uuid: UUID, mode: number): number {
    const definition = this.characteristics.get(uuid)!;
    const allowed =
      mode === 0 || definition.properties.includes(mode === 1 ? 'notify' : 'indicate');
    if (!allowed) return AttError.CCCD_IMPROPERLY_CONFIGURED;
    const centrals = this.subscribers.get(uuid) ?? new Map<string, number>();
    const was = centrals.has(central);
    if (mode === 0) centrals.delete(central);
    else centrals.set(central, mode);
    this.subscribers.set(uuid, centrals);
    if (was !== (mode !== 0)) {
      this.emitter.emit('subscriptionChange', {
        centralId: central,
        characteristic: uuid,
        subscribed: mode !== 0,
      });
    }
    return OK;
  }

  /** The central's link drops (used by `VirtualCentral` and the shared contract test). */
  disconnectCentral(central: string): void {
    for (const [id, request] of this.pending) {
      if (request.central !== central) continue;
      request.cancel();
      this.pending.delete(id);
    }
    this.prepared.delete(central);
    this.cache.drop(central);
    for (const [characteristic, centrals] of this.subscribers) {
      if (centrals.delete(central)) {
        this.emitter.emit('subscriptionChange', {
          centralId: central,
          characteristic,
          subscribed: false,
        });
      }
    }
    // Notifications not delivered yet count as done, without reaching the central.
    const state = this.centrals.get(central);
    this.centrals.delete(central);
    state?.outbox.splice(0).forEach((send) => send());
  }
}

function slice(value: Uint8Array, offset: number): Answer {
  const part = ServerReadCache.slice(value, offset);
  return part ? { status: OK, value: part } : { status: AttError.INVALID_OFFSET };
}
