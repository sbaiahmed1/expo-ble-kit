import type { GattServerObjectEvents } from '../ExpoBleKit.types';
import { BleError, BleErrorCode } from '../errors';
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
import { Emitter } from './Emitter';

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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.pending.forEach((request) => request.cancel());
    this.pending.clear();
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
  }
}

function slice(value: Uint8Array, offset: number): Answer {
  const part = ServerReadCache.slice(value, offset);
  return part ? { status: OK, value: part } : { status: AttError.INVALID_OFFSET };
}
