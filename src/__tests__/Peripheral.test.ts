import { Platform } from 'react-native';

import { BleError, BleManager, type Peripheral } from '../index';
import { installFakeBle, type FakeBle, type VirtualPeripheral } from '../testing';

// P1-12: the public Peripheral (plan §5.4) over the fake adapter: defaults, validation, signals,
// subscriptions and error context.

const TEST_SERVICE = '0c6c1000-b347-4cfa-9827-1c5a13658519';
const STATIC_READ = '0c6c1001-b347-4cfa-9827-1c5a13658519';
const ECHO_WRITE = '0c6c1003-b347-4cfa-9827-1c5a13658519';
const STREAM = '0c6c1007-b347-4cfa-9827-1c5a13658519';

const profile = {
  name: 'BleKit-Test',
  mtu: 247,
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

const settle = () => jest.advanceTimersByTimeAsync(10);
const wait = (ms: number) => jest.advanceTimersByTimeAsync(ms);

async function errorOf(promise: Promise<unknown>): Promise<BleError | null> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BleError);
    return error as BleError;
  }
  return null;
}

const codeOf = async (promise: Promise<unknown>) => (await errorOf(promise))?.code ?? 'ok';

/** Runs `promise` to completion with the fake's timers. The caller handles a rejection. */
async function run<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  await settle();
  return promise;
}

describe('Peripheral', () => {
  let fake: FakeBle;
  let device: VirtualPeripheral;
  let peripheral: Peripheral;

  beforeEach(async () => {
    jest.useFakeTimers();
    fake = installFakeBle();
    device = fake.addPeripheral(profile);
    await settle();
    peripheral = BleManager.getPeripheral(device.id);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const connect = () => run(peripheral.connect());

  describe('connecting', () => {
    it('connects with discovery and the MTU exchange, and reports states', async () => {
      const states: string[] = [];
      peripheral.addConnectionStateListener((state, error) =>
        states.push(error ? `${state} ${error.code}` : state)
      );
      await connect();
      expect(peripheral.state).toBe('connected');
      expect(peripheral.services.map((s) => s.uuid)).toEqual([TEST_SERVICE]);
      expect(peripheral.mtu).toBe(247);
      expect(peripheral.name).toBe('BleKit-Test');

      device.disconnect('linkLoss');
      expect(states).toEqual(['connecting', 'connected', 'disconnected DISCONNECTED']);
      expect(peripheral.mtu).toBe(23);
    });

    it('a timeout rejects with the peripheral in the error', async () => {
      device.advertise(false);
      const failed = errorOf(peripheral.connect({ timeoutMs: 1000 }));
      await jest.advanceTimersByTimeAsync(1000);
      const error = await failed;
      expect(error?.code).toBe('CONNECTION_TIMEOUT');
      expect(error?.peripheralId).toBe(device.id);
    });

    it('a signal cancels the attempt', async () => {
      device.advertise(false);
      const controller = new AbortController();
      const connecting = codeOf(peripheral.connect({ timeoutMs: null, signal: controller.signal }));
      await settle();
      controller.abort();
      expect(await connecting).toBe('OPERATION_CANCELLED');
      expect(peripheral.state).toBe('disconnected');
      expect(await codeOf(peripheral.connect({ signal: controller.signal }))).toBe(
        'OPERATION_CANCELLED'
      );
    });

    it('rejects options of later tasks and invalid ones', async () => {
      if (Platform.OS === 'ios') {
        expect(await codeOf(peripheral.connect({ keepAliveInBackground: true }))).toBe(
          'NOT_SUPPORTED'
        );
      }
      if (Platform.OS === 'android') {
        expect(await codeOf(peripheral.connect({ android: { phy: ['le2m'] } }))).toBe(
          'NOT_SUPPORTED'
        );
      }
      expect(await codeOf(peripheral.connect({ reconnect: { maxAttempts: 0 } }))).toBe(
        'INVALID_ARGUMENT'
      );
      expect(await codeOf(peripheral.connect({ ios: { enableAutoReconnect: true } }))).toBe(
        'INVALID_ARGUMENT'
      );
      expect(await codeOf(peripheral.connect({ timeoutMs: -1 }))).toBe('INVALID_ARGUMENT');
      expect(await codeOf(peripheral.connect({ signal: {} as AbortSignal }))).toBe(
        'INVALID_ARGUMENT'
      );
      expect(peripheral.state).toBe('disconnected');
    });
  });

  describe('operations', () => {
    beforeEach(connect);

    it('reads, writes and uses descriptors with normalized UUIDs', async () => {
      expect(await run(peripheral.read(TEST_SERVICE, STATIC_READ))).toEqual(
        new Uint8Array([1, 2, 3])
      );
      await run(
        peripheral.write(TEST_SERVICE, ECHO_WRITE, new Uint8Array([9]), { withResponse: false })
      );
      expect(device.writes).toEqual([
        { characteristic: ECHO_WRITE, value: new Uint8Array([9]), withResponse: false },
      ]);
      const description = await run(peripheral.readDescriptor(TEST_SERVICE, STREAM, '2901'));
      expect(new TextDecoder().decode(description)).toBe('Stream');
      await run(
        peripheral.writeDescriptor(TEST_SERVICE, STREAM, 0x2901, new TextEncoder().encode('S'))
      );
      expect(await run(peripheral.discover(['0C6C1000-B347-4CFA-9827-1C5A13658519']))).toHaveLength(
        1
      );
    });

    it('validates before the radio and names the attribute in errors', async () => {
      expect(await codeOf(peripheral.read('nope', STATIC_READ))).toBe('INVALID_ARGUMENT');
      expect(await codeOf(peripheral.write(TEST_SERVICE, ECHO_WRITE, [1] as never))).toBe(
        'INVALID_ARGUMENT'
      );
      expect(await codeOf(peripheral.read(TEST_SERVICE, STATIC_READ, { timeoutMs: 0 }))).toBe(
        'INVALID_ARGUMENT'
      );
      const error = await errorOf(run(peripheral.read(TEST_SERVICE, ECHO_WRITE)));
      expect(error?.code).toBe('READ_NOT_PERMITTED');
      expect(error).toMatchObject({
        peripheralId: device.id,
        serviceUUID: TEST_SERVICE,
        characteristicUUID: ECHO_WRITE,
      });
      expect(await codeOf(peripheral.requestMtu(600))).toBe('INVALID_ARGUMENT');
    });

    it('an aborted signal cancels a queued operation before it reaches the radio', async () => {
      const controller = new AbortController();
      const first = peripheral.read(TEST_SERVICE, STATIC_READ);
      const queued = codeOf(
        peripheral.write(TEST_SERVICE, ECHO_WRITE, new Uint8Array([1]), {
          signal: controller.signal,
        })
      );
      controller.abort();
      expect(await queued).toBe('OPERATION_CANCELLED');
      await run(first);
      await settle();
      expect(device.writes).toEqual([]);

      expect(
        await codeOf(peripheral.read(TEST_SERVICE, STATIC_READ, { signal: controller.signal }))
      ).toBe('OPERATION_CANCELLED');
    });

    it('a signal that never aborts changes nothing', async () => {
      const controller = new AbortController();
      const signal = controller.signal;
      expect(await run(peripheral.readRssi({ signal }))).toBe(-60);
      expect(await run(peripheral.requestMtu(185, { signal }))).toBe(185);
      expect(peripheral.mtu).toBe(185);
      expect(await run(peripheral.discover(undefined, { signal }))).toHaveLength(1);
      controller.abort();
    });

    it('pending operations reject with DISCONNECTED on link loss', async () => {
      const pending = codeOf(peripheral.read(TEST_SERVICE, STATIC_READ));
      device.disconnect('linkLoss');
      expect(await pending).toBe('DISCONNECTED');
    });
  });

  describe('reconnection', () => {
    const reconnect = { maxAttempts: 3, initialDelayMs: 1000 };

    it('reconnects after a link loss, and a read from the connected listener succeeds', async () => {
      const states: string[] = [];
      let readInListener: Promise<Uint8Array> | null = null;
      peripheral.addConnectionStateListener((state, error) => {
        states.push(error ? `${state} ${error.code}` : state);
        if (state === 'connected' && states.includes('reconnecting DISCONNECTED')) {
          readInListener = peripheral.read(TEST_SERVICE, STATIC_READ);
        }
      });
      await run(peripheral.connect({ reconnect }));
      device.disconnect('linkLoss');
      expect(peripheral.state).toBe('reconnecting');
      await wait(1100);
      expect(states).toEqual(['connecting', 'connected', 'reconnecting DISCONNECTED', 'connected']);
      expect(await run(readInListener!)).toEqual(new Uint8Array([1, 2, 3]));
    });

    it('keeps subscriptions and restores their CCCD before connected', async () => {
      await run(peripheral.connect({ reconnect }));
      const values: number[] = [];
      const subscription = await run(
        peripheral.subscribe(TEST_SERVICE, STREAM, (v) => values.push(v[0]))
      );
      device.disconnect('linkLoss');
      expect(subscription.active).toBe(true);
      expect(device.isNotifying(TEST_SERVICE, STREAM)).toBe(false);
      await wait(1100);
      expect(device.isNotifying(TEST_SERVICE, STREAM)).toBe(true);
      device.notify(TEST_SERVICE, STREAM, new Uint8Array([9]));
      expect(values).toEqual([9]);
    });

    it('ends subscriptions that are not restored, or fail to restore', async () => {
      await run(peripheral.connect({ reconnect, restoreSubscriptionsOnReconnect: false }));
      const dropped = await run(peripheral.subscribe(TEST_SERVICE, STREAM, () => {}));
      device.disconnect('linkLoss');
      expect(dropped.active).toBe(false);
      await wait(1100);
      expect(device.isNotifying(TEST_SERVICE, STREAM)).toBe(false);

      await run(peripheral.disconnect());
      await run(peripheral.connect({ reconnect }));
      const failing = await run(peripheral.subscribe(TEST_SERVICE, STREAM, () => {}));
      fake.injectError({ op: 'subscribe', characteristic: STREAM }, 'GATT_ERROR');
      device.disconnect('linkLoss');
      await wait(1100);
      expect(peripheral.state).toBe('connected');
      expect(failing.active).toBe(false);
      const diagnostics = await BleManager.getDiagnostics();
      expect(diagnostics.recentErrors.at(-1)).toMatchObject({
        code: 'GATT_ERROR',
        characteristicUUID: STREAM,
      });
    });

    it('gives up after maxAttempts with the last error', async () => {
      const states: string[] = [];
      peripheral.addConnectionStateListener((state, error) =>
        states.push(error ? `${state} ${error.code}` : state)
      );
      await run(peripheral.connect({ timeoutMs: 1000, reconnect: { maxAttempts: 2 } }));
      device.advertise(false);
      device.disconnect('linkLoss');
      await wait(1000 + 1000 + 2000 + 1000);
      expect(states.at(-1)).toBe('disconnected CONNECTION_TIMEOUT');
      expect(states.filter((s) => s.startsWith('reconnecting'))).toHaveLength(1);
    });

    it('a connect during reconnection joins it; disconnect stops it', async () => {
      await run(peripheral.connect({ reconnect }));
      device.disconnect('linkLoss');
      const joined = peripheral.connect();
      await wait(1100);
      await joined;
      expect(peripheral.state).toBe('connected');

      device.disconnect('linkLoss');
      const cancelled = codeOf(peripheral.connect());
      await run(peripheral.disconnect());
      expect(await cancelled).toBe('OPERATION_CANCELLED');
      await wait(60_000);
      expect(peripheral.state).toBe('disconnected');
    });
  });

  describe('subscriptions', () => {
    beforeEach(connect);

    it('fans values out; the last subscriber out disables the CCCD', async () => {
      const first: number[] = [];
      const second: number[] = [];
      const a = await run(peripheral.subscribe(TEST_SERVICE, STREAM, (v) => first.push(v[0])));
      const b = await run(
        peripheral.subscribe('0c6c1000-b347-4cfa-9827-1c5a13658519', STREAM, (v, timestamp) => {
          second.push(v[0]);
          expect(timestamp).toBeGreaterThan(0);
        })
      );
      expect(device.isNotifying(TEST_SERVICE, STREAM)).toBe(true);

      device.notify(TEST_SERVICE, STREAM, new Uint8Array([1]));
      await run(a.unsubscribe());
      expect(a.active).toBe(false);
      device.notify(TEST_SERVICE, STREAM, new Uint8Array([2]));
      expect(device.isNotifying(TEST_SERVICE, STREAM)).toBe(true);

      b.remove();
      await settle();
      expect(b.active).toBe(false);
      expect(device.isNotifying(TEST_SERVICE, STREAM)).toBe(false);
      expect(first).toEqual([1]);
      expect(second).toEqual([1, 2]);
      await b.unsubscribe();
    });

    it('a listener that throws does not stop the others', async () => {
      const values: number[] = [];
      await run(
        peripheral.subscribe(TEST_SERVICE, STREAM, () => {
          throw new Error('app bug');
        })
      );
      await run(peripheral.subscribe(TEST_SERVICE, STREAM, (v) => values.push(v[0])));
      device.notify(TEST_SERVICE, STREAM, new Uint8Array([5]));
      expect(values).toEqual([5]);
      expect(() => jest.runOnlyPendingTimers()).toThrow('app bug');
    });

    it('ends with the connection', async () => {
      const subscription = await run(peripheral.subscribe(TEST_SERVICE, STREAM, () => {}));
      device.disconnect('linkLoss');
      expect(subscription.active).toBe(false);
      expect(await codeOf(subscription.unsubscribe())).toBe('ok');
    });

    it('rejects what the characteristic lacks, and a signal cancels a pending subscribe', async () => {
      expect(await codeOf(run(peripheral.subscribe(TEST_SERVICE, STATIC_READ, () => {})))).toBe(
        'NOT_SUPPORTED'
      );
      expect(await codeOf(peripheral.subscribe(TEST_SERVICE, STREAM, 'x' as never))).toBe(
        'INVALID_ARGUMENT'
      );
      const controller = new AbortController();
      const pending = codeOf(
        peripheral.subscribe(TEST_SERVICE, STREAM, () => {}, { signal: controller.signal })
      );
      controller.abort();
      expect(await run(pending)).toBe('OPERATION_CANCELLED');
      await settle();
      expect(device.isNotifying(TEST_SERVICE, STREAM)).toBe(false);
    });
  });
});
