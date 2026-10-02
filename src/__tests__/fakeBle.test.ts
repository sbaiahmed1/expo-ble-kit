import type { ConnectionStateEvent } from '../ExpoBleKit.types';
import ExpoBleKit, { BleError, type ScanResult } from '../index';
import { toNativeAttributeRequest } from '../internal/attributeRequest';
import { toNativeConnectOptions } from '../internal/connectOptions';
import type { NativePeripheralPort } from '../internal/port';
import { toNativeScanOptions } from '../internal/scanOptions';
import { installFakeBle, type FakeBle, type VirtualPeripheral } from '../testing';

// P1-13: the fake behaves like the native cores (plan §5.3, §5.4, §5.8), seen through the same
// lazy native module the rest of the TS layer uses.

const TEST_SERVICE = '0c6c1000-b347-4cfa-9827-1c5a13658519';
const STATIC_READ = '0c6c1001-b347-4cfa-9827-1c5a13658519';
const ECHO_WRITE = '0c6c1003-b347-4cfa-9827-1c5a13658519';
const STREAM = '0c6c1007-b347-4cfa-9827-1c5a13658519';

const profile = {
  name: 'BleKit-Test',
  services: [
    {
      uuid: TEST_SERVICE,
      characteristics: [
        { uuid: STATIC_READ, properties: ['read' as const], value: new Uint8Array([1, 2, 3]) },
        { uuid: ECHO_WRITE, properties: ['write' as const, 'writeWithoutResponse' as const] },
        {
          uuid: STREAM,
          properties: ['notify' as const],
          descriptors: [{ uuid: '2901', value: new TextEncoder().encode('Stream') }],
        },
      ],
    },
  ],
};

/** Runs everything the fake scheduled (its radio answers on later ticks). */
const settle = () => jest.advanceTimersByTimeAsync(10);

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return BleError.fromNative(error).code;
  }
  return 'ok';
}

describe('importing without a native module', () => {
  it('does not throw, and calls say what is missing', () => {
    expect(() => ExpoBleKit.getState()).toThrow(/native module is missing/);
  });
});

describe('the fake', () => {
  let fake: FakeBle;
  let device: VirtualPeripheral;

  beforeEach(async () => {
    jest.useFakeTimers();
    fake = installFakeBle();
    device = fake.addPeripheral(profile);
    await settle();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** Connects with the defaults (15 s timeout, autoDiscover) and records state events. */
  async function connected(id = device.id) {
    const peripheral = ExpoBleKit.getPeripheral(id);
    const events: string[] = [];
    peripheral.addListener('connectionStateChange', (event: ConnectionStateEvent) =>
      events.push(event.code ? `${event.state} ${event.code}` : event.state)
    );
    const connecting = peripheral.connect(toNativeConnectOptions());
    await settle();
    await connecting;
    return { peripheral, events };
  }

  const request = (characteristic: string, descriptor?: string, withResponse = true) =>
    toNativeAttributeRequest(TEST_SERVICE, characteristic, descriptor, { withResponse });

  describe('state and permissions', () => {
    it('reports and changes the adapter state', async () => {
      const states: string[] = [];
      ExpoBleKit.addListener('stateChange', ({ state }) => states.push(state));
      expect(ExpoBleKit.getState()).toBe('poweredOn');
      fake.setState('poweredOff');
      expect(ExpoBleKit.getState()).toBe('poweredOff');
      expect(states).toEqual(['poweredOff']);
      expect((await ExpoBleKit.requestPermissionsAsync()).scan).toBe('granted');
    });

    it('takes the initial state and permissions', async () => {
      installFakeBle({
        state: 'unauthorized',
        permissions: { scan: 'denied', canAskAgain: false },
      });
      expect(ExpoBleKit.getState()).toBe('unauthorized');
      expect(await ExpoBleKit.getPermissionsAsync()).toMatchObject({
        scan: 'denied',
        connect: 'granted',
        canAskAgain: false,
      });
    });
  });

  describe('scanning', () => {
    function scan(sessionId: number, options: Parameters<typeof toNativeScanOptions>[0]) {
      const results: ScanResult[] = [];
      const ended: string[] = [];
      ExpoBleKit.addListener('scanResults', (event) => {
        if (event.sessionId === sessionId) results.push(...event.results);
      });
      ExpoBleKit.addListener('scanError', (event) => {
        if (event.sessionId === sessionId) ended.push(event.code);
      });
      return {
        started: ExpoBleKit.startScan(sessionId, toNativeScanOptions(options)),
        results,
        ended,
      };
    }

    it('gives each session only its matches, and stopping one leaves the other running', async () => {
      fake.addPeripheral({ name: 'Pulse', services: [{ uuid: '180d', characteristics: [] }] });
      const testOnly = scan(1, { services: [TEST_SERVICE] });
      const pulseOnly = scan(2, { namePrefix: 'Pul' });
      await settle();
      expect(testOnly.results.map((r) => r.name)).toEqual(['BleKit-Test']);
      expect(pulseOnly.results.map((r) => r.name)).toEqual(['Pulse']);
      expect(testOnly.results[0]).toMatchObject({
        id: device.id,
        rssi: -60,
        serviceUUIDs: [TEST_SERVICE],
      });

      await ExpoBleKit.stopScan(1);
      fake.addPeripheral({ name: 'Pulse 2', services: [] });
      await settle();
      expect(pulseOnly.results.map((r) => r.name)).toEqual(['Pulse', 'Pulse 2']);
      expect(testOnly.results).toHaveLength(1);
    });

    it('reports a device once unless duplicates are allowed, and again when it re-advertises', async () => {
      const once = scan(1, {});
      const all = scan(2, { allowDuplicates: true });
      await settle();
      device.advertise(false);
      device.advertise(true);
      await settle();
      expect(once.results).toHaveLength(1);
      expect(all.results).toHaveLength(2);
    });

    it('checks the adapter and permissions, and ends sessions when Bluetooth turns off', async () => {
      const session = scan(1, {});
      await session.started;
      fake.setState('poweredOff');
      expect(session.ended).toEqual(['BLUETOOTH_POWERED_OFF']);
      expect(await codeOf(ExpoBleKit.startScan(2, toNativeScanOptions()))).toBe(
        'BLUETOOTH_POWERED_OFF'
      );

      installFakeBle({ permissions: { scan: 'denied' } });
      expect(await codeOf(ExpoBleKit.startScan(3, toNativeScanOptions()))).toBe(
        'PERMISSION_DENIED'
      );
    });
  });

  describe('connecting', () => {
    it('reports connected before connect resolves, with services discovered', async () => {
      const { peripheral, events } = await connected();
      expect(events).toEqual(['connecting', 'connected']);
      expect(peripheral.state).toBe('connected');
      expect(peripheral.services.map((s) => s.uuid)).toEqual([TEST_SERVICE]);
      expect(ExpoBleKit.getPeripheral(device.id)).toBe(peripheral);
    });

    it('times out on an absent device', async () => {
      const peripheral = ExpoBleKit.getPeripheral('absent');
      const connecting = codeOf(peripheral.connect(toNativeConnectOptions({ timeoutMs: 5000 })));
      await jest.advanceTimersByTimeAsync(4999);
      expect(peripheral.state).toBe('connecting');
      await jest.advanceTimersByTimeAsync(1);
      expect(await connecting).toBe('CONNECTION_TIMEOUT');
      expect(peripheral.state).toBe('disconnected');
    });

    it('without a timeout waits until the device appears, or until disconnect cancels it', async () => {
      device.advertise(false);
      const peripheral = ExpoBleKit.getPeripheral(device.id);
      const events: ConnectionStateEvent[] = [];
      peripheral.addListener('connectionStateChange', (event) => events.push(event));
      const waiting = peripheral.connect(toNativeConnectOptions({ timeoutMs: null }));
      await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(peripheral.state).toBe('connecting');
      device.advertise(true);
      await settle();
      await waiting;
      expect(peripheral.state).toBe('connected');

      const disconnecting = peripheral.disconnect();
      await settle();
      await disconnecting;
      device.advertise(false);
      const cancelled = codeOf(peripheral.connect(toNativeConnectOptions({ timeoutMs: null })));
      await peripheral.disconnect();
      expect(await cancelled).toBe('OPERATION_CANCELLED');
      expect(events.at(-1)).toEqual({ state: 'disconnected' });
    });

    it('fails with injected errors, and drops connections when Bluetooth turns off', async () => {
      fake.injectError({ op: 'connect', peripheralId: device.id }, 'CONNECTION_FAILED');
      const peripheral = ExpoBleKit.getPeripheral(device.id);
      const failing = codeOf(peripheral.connect(toNativeConnectOptions()));
      await settle();
      expect(await failing).toBe('CONNECTION_FAILED');

      const { events } = await connected();
      fake.setState('poweredOff');
      expect(events.at(-1)).toBe('disconnected BLUETOOTH_POWERED_OFF');
      expect(await codeOf(peripheral.connect(toNativeConnectOptions()))).toBe(
        'BLUETOOTH_POWERED_OFF'
      );
    });
  });

  describe('operations', () => {
    let peripheral: NativePeripheralPort;

    beforeEach(async () => {
      ({ peripheral } = await connected());
    });

    it('reads, writes and records writes', async () => {
      const value = peripheral.read(request(STATIC_READ));
      await settle();
      expect(await value).toEqual(new Uint8Array([1, 2, 3]));

      const write = peripheral.write(request(ECHO_WRITE, undefined, false), new Uint8Array([9]));
      await settle();
      await write;
      expect(device.writes).toEqual([
        { characteristic: ECHO_WRITE, value: new Uint8Array([9]), withResponse: false },
      ]);

      device.setValue(TEST_SERVICE, STATIC_READ, new Uint8Array([7]));
      const changed = peripheral.read(request(STATIC_READ));
      await settle();
      expect(await changed).toEqual(new Uint8Array([7]));
    });

    it('runs operations one at a time, in order', async () => {
      const order: string[] = [];
      const first = peripheral.read(request(STATIC_READ)).then(() => order.push('read'));
      const second = peripheral
        .write(request(ECHO_WRITE), new Uint8Array([1]))
        .then(() => order.push('write'));
      const third = peripheral.read(request(STATIC_READ)).then(() => order.push('read again'));
      await jest.runAllTimersAsync();
      await Promise.all([first, second, third]);
      expect(order).toEqual(['read', 'write', 'read again']);
    });

    it('checks like the native cores', async () => {
      expect(await codeOf(peripheral.read(request(ECHO_WRITE)))).toBe('READ_NOT_PERMITTED');
      expect(await codeOf(peripheral.write(request(STATIC_READ), new Uint8Array([1])))).toBe(
        'WRITE_NOT_PERMITTED'
      );
      expect(
        await codeOf(peripheral.write(request(ECHO_WRITE, undefined, false), new Uint8Array(21)))
      ).toBe('INVALID_ATTRIBUTE_LENGTH');
      expect(await codeOf(peripheral.read(request('2a37')))).toBe('CHARACTERISTIC_NOT_FOUND');
      expect(await codeOf(peripheral.readDescriptor(request(STREAM, '2904')))).toBe(
        'DESCRIPTOR_NOT_FOUND'
      );
      expect(
        await codeOf(peripheral.writeDescriptor(request(STREAM, '2902'), new Uint8Array([1, 0])))
      ).toBe('INVALID_ARGUMENT');
      const description = peripheral.readDescriptor(request(STREAM, '2901'));
      await settle();
      expect(new TextDecoder().decode(await description)).toBe('Stream');
    });

    it('fails injected errors, and pending operations on link loss', async () => {
      fake.injectError({ op: 'read', characteristic: STATIC_READ }, 'INSUFFICIENT_AUTHENTICATION');
      const denied = codeOf(peripheral.read(request(STATIC_READ)));
      await settle();
      expect(await denied).toBe('INSUFFICIENT_AUTHENTICATION');

      const pending = codeOf(peripheral.read(request(STATIC_READ)));
      device.disconnect('linkLoss');
      expect(await pending).toBe('DISCONNECTED');
      expect(peripheral.state).toBe('disconnected');
      expect(peripheral.services).toEqual([]);
      expect(await codeOf(peripheral.read(request(STATIC_READ)))).toBe('DISCONNECTED');
    });

    it('needs discovery for attributes when autoDiscover is off', async () => {
      const disconnecting = peripheral.disconnect();
      await settle();
      await disconnecting;
      const connecting = peripheral.connect(toNativeConnectOptions({ autoDiscover: false }));
      await settle();
      await connecting;
      expect(await codeOf(peripheral.read(request(STATIC_READ)))).toBe('SERVICE_NOT_FOUND');
      const discovery = peripheral.discover([TEST_SERVICE], 30_000);
      await settle();
      expect((await discovery).map((s) => s.uuid)).toEqual([TEST_SERVICE]);
      const value = peripheral.read(request(STATIC_READ));
      await settle();
      expect(await value).toEqual(new Uint8Array([1, 2, 3]));
    });
  });

  describe('subscriptions', () => {
    let peripheral: NativePeripheralPort;
    let values: number[];

    beforeEach(async () => {
      ({ peripheral } = await connected());
      values = [];
      peripheral.addListener('notification', (event) => values.push(...event.value));
    });

    /** The outcome code ('ok' or a BleErrorCode); the handler is attached before time moves. */
    async function subscribe(
      id: number,
      mode: 'auto' | 'notify' | 'indicate' = 'auto',
      characteristic = STREAM
    ) {
      const outcome = codeOf(peripheral.subscribe(request(characteristic), id, mode));
      await settle();
      return outcome;
    }

    async function unsubscribe(id: number) {
      const outcome = codeOf(peripheral.unsubscribe(id, 10_000));
      await settle();
      return outcome;
    }

    it('shares one CCCD, and the last subscriber out disables it on the peripheral', async () => {
      device.notify(TEST_SERVICE, STREAM, new Uint8Array([1]));
      expect(values).toEqual([]);

      expect(await subscribe(1)).toBe('ok');
      expect(await subscribe(2)).toBe('ok');
      expect(device.isNotifying(TEST_SERVICE, STREAM)).toBe(true);
      device.notify(TEST_SERVICE, STREAM, new Uint8Array([2]));
      expect(values).toEqual([2]);

      expect(await unsubscribe(1)).toBe('ok');
      device.notify(TEST_SERVICE, STREAM, new Uint8Array([3]));
      expect(values).toEqual([2, 3]);
      expect(device.isNotifying(TEST_SERVICE, STREAM)).toBe(true);

      expect(await unsubscribe(2)).toBe('ok');
      expect(device.isNotifying(TEST_SERVICE, STREAM)).toBe(false);
      device.notify(TEST_SERVICE, STREAM, new Uint8Array([4]));
      expect(values).toEqual([2, 3]);
    });

    it('rejects a failed CCCD write, and modes the characteristic lacks', async () => {
      expect(await subscribe(1, 'indicate')).toBe('NOT_SUPPORTED');
      expect(await subscribe(2, 'auto', STATIC_READ)).toBe('NOT_SUPPORTED');

      expect(await subscribe(3)).toBe('ok');
      fake.injectError({ op: 'unsubscribe', characteristic: STREAM }, 'WRITE_NOT_PERMITTED');
      expect(await unsubscribe(3)).toBe('WRITE_NOT_PERMITTED');
      device.notify(TEST_SERVICE, STREAM, new Uint8Array([1]));
      expect(values).toEqual([]);

      fake.injectError({ op: 'subscribe' }, 'INSUFFICIENT_AUTHENTICATION');
      expect(await subscribe(4)).toBe('INSUFFICIENT_AUTHENTICATION');
    });

    it('ends with the connection', async () => {
      expect(await subscribe(1)).toBe('ok');
      device.disconnect('linkLoss');
      expect(device.isNotifying(TEST_SERVICE, STREAM)).toBe(false);
      expect(await unsubscribe(1)).toBe('ok');
      expect(await subscribe(2)).toBe('DISCONNECTED');
    });
  });

  it('reset forgets everything', async () => {
    const { peripheral } = await connected();
    fake.reset();
    expect(peripheral.state).toBe('disconnected');
    expect((await ExpoBleKit.getDiagnosticsAsync()).sessions).toEqual([]);
  });
});
