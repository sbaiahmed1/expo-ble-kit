import {
  BleError,
  BleManager,
  type GattServer,
  type LogEntry,
  type ServiceDefinition,
  type WriteRequest,
} from '../index';
import { installFakeBle, type FakeBle, type VirtualCentral } from '../testing';

// P4-01: the GATT server through the public API, driven by the fake's virtual central.

const SERVICE = '0c6c2000-b347-4cfa-9827-1c5a13658519';
const DYNAMIC = '0c6c2001-b347-4cfa-9827-1c5a13658519';
const STATIC = '0c6c2002-b347-4cfa-9827-1c5a13658519';
const NOTIFY = '0c6c2003-b347-4cfa-9827-1c5a13658519';
const WRITE_ONLY = '0c6c2004-b347-4cfa-9827-1c5a13658519';

const services: ServiceDefinition[] = [
  {
    uuid: SERVICE,
    characteristics: [
      { uuid: DYNAMIC, properties: ['read', 'write'], permissions: ['readable', 'writeable'] },
      {
        uuid: STATIC,
        properties: ['read'],
        permissions: ['readable'],
        value: Uint8Array.of(1, 2, 3),
        descriptors: [{ uuid: '2901', value: new TextEncoder().encode('Static') }],
      },
      { uuid: NOTIFY, properties: ['notify', 'indicate'], permissions: [] },
      { uuid: WRITE_ONLY, properties: ['writeWithoutResponse'], permissions: ['writeable'] },
    ],
  },
];

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error) => error.code
  );

describe('GATT server', () => {
  let fake: FakeBle;
  let server: GattServer;
  let central: VirtualCentral;

  async function settle<T>(promise: Promise<T>, ms = 10): Promise<T> {
    promise.catch(() => {});
    await jest.advanceTimersByTimeAsync(ms);
    return promise;
  }

  beforeEach(async () => {
    jest.useFakeTimers();
    fake = installFakeBle();
    server = await settle(BleManager.openGattServer(services));
    central = fake.connectCentral({ id: 'central-A' });
  });

  afterEach(() => {
    BleManager.setLogHandler(null);
    jest.useRealTimers();
  });

  it('answers a read with the handler value, and a static value without it', async () => {
    const handler = jest.fn(() => Uint8Array.of(9, 8));
    server.onReadRequest(handler);
    expect(await settle(central.read(DYNAMIC))).toEqual(Uint8Array.of(9, 8));
    expect(handler).toHaveBeenCalledWith({
      centralId: 'central-A',
      characteristic: DYNAMIC,
      offset: 0,
    });
    expect(await settle(central.read(STATIC))).toEqual(Uint8Array.of(1, 2, 3));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('serves a 512-byte read at MTU 23 from one handler result, while the value changes', async () => {
    let version = 0;
    // Each call returns another value: a long read built from two of them would show it.
    const handler = jest.fn(() => {
      const shift = version++;
      return Uint8Array.from({ length: 512 }, (_, i) => (i + shift) & 0xff);
    });
    server.onReadRequest(handler);
    const value = await settle(central.read(DYNAMIC), 100);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(value).toEqual(Uint8Array.from({ length: 512 }, (_, i) => i & 0xff));
  });

  it('delivers writes, long writes as one value, and refusals as the central sees them', async () => {
    const writes: WriteRequest[] = [];
    server.onWriteRequest((request) => {
      writes.push(request);
      if (request.value[0] === 0xff) throw new BleError('WRITE_NOT_PERMITTED', 'no');
    });
    await settle(central.write(DYNAMIC, Uint8Array.of(1, 2)));
    const long = Uint8Array.from({ length: 100 }, (_, i) => i);
    await settle(central.write(DYNAMIC, long), 50);
    expect(writes.map((w) => [w.value.length, w.offset, w.withResponse])).toEqual([
      [2, 0, true],
      [100, 0, true],
    ]);
    expect(writes[1].value).toEqual(long);
    expect(await code(settle(central.write(DYNAMIC, Uint8Array.of(0xff))))).toBe(
      'WRITE_NOT_PERMITTED'
    );
    await settle(central.write(WRITE_ONLY, Uint8Array.of(5), { withResponse: false }));
    expect(writes.at(-1)).toMatchObject({ characteristic: WRITE_ONLY, withResponse: false });
    expect(await code(settle(central.write(STATIC, Uint8Array.of(1))))).toBe('WRITE_NOT_PERMITTED');
  });

  it('refuses requests without a handler, and the handler can be replaced or removed', async () => {
    expect(await code(settle(central.read(DYNAMIC)))).toBe('READ_NOT_PERMITTED');
    expect(await code(settle(central.write(DYNAMIC, Uint8Array.of(1))))).toBe(
      'WRITE_NOT_PERMITTED'
    );
    const first = server.onReadRequest(() => Uint8Array.of(1));
    server.onReadRequest(() => Uint8Array.of(2));
    first.remove(); // a replaced handler's remove() leaves the new one
    expect(await settle(central.read(DYNAMIC))).toEqual(Uint8Array.of(2));
  });

  it('answers a request left past the deadline with an ATT error and a warning', async () => {
    const entries: LogEntry[] = [];
    BleManager.setLogHandler((entry) => entries.push(entry));
    server.onReadRequest(() => new Promise<Uint8Array>(() => {}));
    const read = central.read(DYNAMIC);
    expect(await code(settle(read, 25_000))).toBe('GATT_ERROR');
    expect(entries.at(-1)?.message).toMatch(
      /^OPERATION_TIMEOUT: The read request .* wasn't answered within 25000 ms/
    );
  });

  it('turns bad handler values into ATT errors', async () => {
    server.onReadRequest(() => 'nope' as never);
    expect(await code(settle(central.read(DYNAMIC)))).toBe('GATT_ERROR');
    server.onReadRequest(() => new Uint8Array(513));
    expect(await code(settle(central.read(DYNAMIC)))).toBe('INVALID_ATTRIBUTE_LENGTH');
    server.onReadRequest(() => {
      throw new BleError('INSUFFICIENT_ENCRYPTION', 'pair first');
    });
    expect(await code(settle(central.read(DYNAMIC)))).toBe('INSUFFICIENT_ENCRYPTION');
  });

  it('reports subscriptions, and a disconnect ends them', async () => {
    const changes: string[] = [];
    server.addSubscriptionListener(({ centralId, characteristic, subscribed }) =>
      changes.push(`${centralId} ${characteristic === NOTIFY} ${subscribed}`)
    );
    await settle(central.subscribe(NOTIFY));
    await settle(central.subscribe(STATIC).catch(() => {}));
    central.disconnect();
    expect(changes).toEqual(['central-A true true', 'central-A true false']);
  });

  describe('notify (P4-02)', () => {
    it('reaches the subscribed centrals, as a notification or an indication', async () => {
      const other = fake.connectCentral({ id: 'central-B', mtu: 185 });
      const idle = fake.connectCentral({ id: 'central-C' });
      await settle(central.subscribe(NOTIFY));
      await settle(other.subscribe(NOTIFY, 'indicate'));
      await settle(server.notify(NOTIFY, Uint8Array.of(1)));
      await settle(server.notify(NOTIFY, Uint8Array.of(2), { centrals: ['central-B'] }));
      expect(central.notifications).toEqual([
        { characteristic: NOTIFY, value: Uint8Array.of(1), indication: false },
      ]);
      expect(other.notifications.map((n) => [n.value[0], n.indication])).toEqual([
        [1, true],
        [2, true],
      ]);
      expect(idle.notifications).toEqual([]);
    });

    it('resolves once the value left, one at a time per central, in order', async () => {
      await settle(central.subscribe(NOTIFY));
      const sent: number[] = [];
      const calls = [1, 2, 3].map((n) =>
        server.notify(NOTIFY, Uint8Array.of(n)).then(() => sent.push(n))
      );
      expect(central.notifications).toEqual([]);
      await jest.advanceTimersByTimeAsync(0);
      expect(sent).toEqual([1]);
      await settle(Promise.all(calls));
      expect(sent).toEqual([1, 2, 3]);
      expect(central.notifications.map((n) => n.value[0])).toEqual([1, 2, 3]);
    });

    it('takes at most MTU − 3 bytes for each target', async () => {
      const big = fake.connectCentral({ id: 'central-B', mtu: 247 });
      await settle(big.subscribe(NOTIFY));
      await settle(server.notify(NOTIFY, new Uint8Array(244)));
      await settle(central.subscribe(NOTIFY));
      expect(await code(settle(server.notify(NOTIFY, new Uint8Array(21))))).toBe(
        'INVALID_ATTRIBUTE_LENGTH'
      );
      await settle(server.notify(NOTIFY, new Uint8Array(244), { centrals: ['central-B'] }));
      expect(big.notifications.map((n) => n.value.length)).toEqual([244, 244]);
    });

    it('resolves without subscribers, and drops a central that disconnects', async () => {
      await settle(server.notify(NOTIFY, Uint8Array.of(1)));
      await settle(central.subscribe(NOTIFY));
      const calls = [1, 2, 3].map((n) => server.notify(NOTIFY, Uint8Array.of(n)));
      await jest.advanceTimersByTimeAsync(0);
      central.disconnect();
      await settle(Promise.all(calls));
      expect(central.notifications.map((n) => n.value[0])).toEqual([1]);
    });

    it('rejects bad arguments, unknown characteristics, and a closed server', async () => {
      expect(await code(settle(server.notify(NOTIFY, [1] as never)))).toBe('INVALID_ARGUMENT');
      expect(await code(settle(server.notify(NOTIFY, new Uint8Array(513))))).toBe(
        'INVALID_ATTRIBUTE_LENGTH'
      );
      expect(
        await code(settle(server.notify(NOTIFY, Uint8Array.of(1), { centrals: 'x' as never })))
      ).toBe('INVALID_ARGUMENT');
      expect(await code(settle(server.notify('not-a-uuid', Uint8Array.of(1))))).toBe(
        'INVALID_ARGUMENT'
      );
      expect(await code(settle(server.notify(SERVICE, Uint8Array.of(1))))).toBe(
        'CHARACTERISTIC_NOT_FOUND'
      );
      expect(await code(settle(server.notify(STATIC, Uint8Array.of(1))))).toBe('NOT_SUPPORTED');
      await settle(central.subscribe(NOTIFY));
      const queued = [1, 2].map((n) => code(server.notify(NOTIFY, Uint8Array.of(n))));
      await settle(server.close(), 0);
      expect(await Promise.all(queued)).toEqual(['DISCONNECTED', 'DISCONNECTED']);
      expect(await code(settle(server.notify(NOTIFY, Uint8Array.of(1))))).toBe('DISCONNECTED');
    });
  });

  it('is one at a time, needs the preconditions, and Bluetooth off closes it', async () => {
    expect(await code(settle(BleManager.openGattServer(services)))).toBe('INVALID_ARGUMENT');
    fake.setState('poweredOff');
    expect(await code(settle(central.read(STATIC)))).toBe('DISCONNECTED');
    expect(await code(settle(BleManager.openGattServer(services)))).toBe('BLUETOOTH_POWERED_OFF');
    fake.setState('poweredOn');
    const again = await settle(BleManager.openGattServer(services));
    await settle(again.close());
    expect(() => fake.connectCentral()).toThrow(expect.objectContaining({ code: 'DISCONNECTED' }));

    installFakeBle({ permissions: { connect: 'denied' } });
    expect(await code(settle(BleManager.openGattServer(services)))).toBe('PERMISSION_DENIED');
  });

  it.each<[string, unknown]>([
    ['no services', []],
    [
      'a duplicate characteristic',
      [
        {
          uuid: SERVICE,
          characteristics: [services[0].characteristics[0], services[0].characteristics[0]],
        },
      ],
    ],
    [
      'an unsupported property',
      [
        {
          uuid: SERVICE,
          characteristics: [{ uuid: DYNAMIC, properties: ['broadcast'], permissions: [] }],
        },
      ],
    ],
    [
      'read without a read permission',
      [
        {
          uuid: SERVICE,
          characteristics: [{ uuid: DYNAMIC, properties: ['read'], permissions: ['writeable'] }],
        },
      ],
    ],
    [
      'a writable static value',
      [
        {
          uuid: SERVICE,
          characteristics: [
            {
              uuid: DYNAMIC,
              properties: ['read', 'write'],
              permissions: ['readable', 'writeable'],
              value: Uint8Array.of(1),
            },
          ],
        },
      ],
    ],
    [
      'a 513-byte value',
      [
        {
          uuid: SERVICE,
          characteristics: [
            {
              uuid: DYNAMIC,
              properties: ['read'],
              permissions: ['readable'],
              value: new Uint8Array(513),
            },
          ],
        },
      ],
    ],
    [
      'a CCCD descriptor',
      [
        {
          uuid: SERVICE,
          characteristics: [
            {
              uuid: NOTIFY,
              properties: ['notify'],
              permissions: [],
              descriptors: [{ uuid: '2902', value: Uint8Array.of(0, 0) }],
            },
          ],
        },
      ],
    ],
    [
      'another descriptor',
      [
        {
          uuid: SERVICE,
          characteristics: [
            {
              uuid: NOTIFY,
              properties: ['notify'],
              permissions: [],
              descriptors: [{ uuid: '2908', value: Uint8Array.of(0) }],
            },
          ],
        },
      ],
    ],
  ])('rejects %s', async (_, definitions) => {
    await settle(server.close());
    expect(await code(settle(BleManager.openGattServer(definitions as never)))).toBe(
      'INVALID_ARGUMENT'
    );
  });
});
