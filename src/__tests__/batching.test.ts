import { BleError, BleManager, type NotificationBatch, type Peripheral } from '../index';
import { installFakeBle, type VirtualPeripheral } from '../testing';

// P2-04: Peripheral.subscribeBatched over the fake adapter, which batches like the native cores.

const TEST_SERVICE = '0c6c1000-b347-4cfa-9827-1c5a13658519';
const STREAM = '0c6c1007-b347-4cfa-9827-1c5a13658519';

const profile = {
  name: 'BleKit-Test',
  services: [
    {
      uuid: TEST_SERVICE,
      characteristics: [{ uuid: STREAM, properties: ['notify' as const] }],
    },
  ],
};

const tick = (ms: number) => jest.advanceTimersByTimeAsync(ms);

describe('subscribeBatched', () => {
  let device: VirtualPeripheral;
  let peripheral: Peripheral;
  let batches: NotificationBatch[];
  const onBatch = (batch: NotificationBatch) => batches.push(batch);
  const send = (...bytes: number[]) => device.notify(TEST_SERVICE, STREAM, Uint8Array.from(bytes));
  const firstBytes = (batch: NotificationBatch) => batch.values.map((value) => value[0]);

  async function subscribe(intervalMs: number, maxItems?: number) {
    const subscribing = peripheral.subscribeBatched(TEST_SERVICE, STREAM, onBatch, {
      intervalMs,
      maxItems,
    });
    await tick(10);
    return subscribing;
  }

  beforeEach(async () => {
    jest.useFakeTimers();
    const fake = installFakeBle();
    device = fake.addPeripheral(profile);
    peripheral = BleManager.getPeripheral(device.id);
    const connecting = peripheral.connect();
    await tick(10);
    await connecting;
    batches = [];
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('delivers the values of one interval as one batch, with their arrival times', async () => {
    await subscribe(16);
    send(1);
    await tick(5);
    send(2);
    await tick(10);
    expect(batches).toHaveLength(0);
    await tick(1);
    expect(batches).toHaveLength(1);
    expect(firstBytes(batches[0])).toEqual([1, 2]);
    expect(batches[0].timestamps[1] - batches[0].timestamps[0]).toBe(5);
    expect(batches[0].dropped).toBe(0);
    await tick(1000);
    expect(batches).toHaveLength(1);
  });

  it('shares a characteristic with an unbatched subscriber', async () => {
    const single: number[] = [];
    await subscribe(16);
    const subscribing = peripheral.subscribe(TEST_SERVICE, STREAM, (value) =>
      single.push(value[0])
    );
    await tick(10);
    await subscribing;
    send(7);
    send(8);
    await tick(16);
    expect(single).toEqual([7, 8]);
    expect(batches.map(firstBytes)).toEqual([[7, 8]]);
  });

  it('drops the oldest values of a full batch and counts them', async () => {
    await subscribe(100, 3);
    [1, 2, 3, 4, 5].forEach((n) => send(n));
    await tick(100);
    expect(firstBytes(batches[0])).toEqual([3, 4, 5]);
    expect(batches[0].dropped).toBe(2);
  });

  it('stops at once on unsubscribe, collected values included', async () => {
    const subscription = await subscribe(16);
    send(1);
    subscription.remove();
    await tick(100);
    expect(batches).toHaveLength(0);
    expect(subscription.active).toBe(false);
  });

  it('delivers the collected values when the connection ends', async () => {
    const subscription = await subscribe(1000);
    send(1);
    send(2);
    device.disconnect('linkLoss');
    await tick(10);
    expect(batches.map(firstBytes)).toEqual([[1, 2]]);
    expect(subscription.active).toBe(false);
  });

  it('keeps 100 Hz × 20 B at one batch per 16 ms or less, in order, none dropped', async () => {
    await subscribe(16);
    const seconds = 60;
    for (let n = 0; n < 100 * seconds; n++) {
      const frame = new Uint8Array(20);
      frame[0] = n % 256;
      device.notify(TEST_SERVICE, STREAM, frame);
      await tick(10);
    }
    await tick(16);
    expect(batches.length / seconds).toBeLessThanOrEqual(63);
    expect(batches.reduce((sum, batch) => sum + batch.dropped, 0)).toBe(0);
    expect(batches.flatMap(firstBytes)).toEqual(
      Array.from({ length: 100 * seconds }, (_, n) => n % 256)
    );
  });

  it('validates its options', async () => {
    const codeOf = async (options: unknown, callback: unknown = onBatch) => {
      const error = await peripheral
        .subscribeBatched(TEST_SERVICE, STREAM, callback as never, options as never)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BleError);
      return (error as BleError).code;
    };
    expect(await codeOf(undefined)).toBe('INVALID_ARGUMENT');
    expect(await codeOf({})).toBe('INVALID_ARGUMENT');
    expect(await codeOf({ intervalMs: 0 })).toBe('INVALID_ARGUMENT');
    expect(await codeOf({ intervalMs: Number.NaN })).toBe('INVALID_ARGUMENT');
    expect(await codeOf({ intervalMs: 16, maxItems: 0 })).toBe('INVALID_ARGUMENT');
    expect(await codeOf({ intervalMs: 16, maxItems: 1.5 })).toBe('INVALID_ARGUMENT');
    expect(await codeOf({ intervalMs: 16 }, 'nope')).toBe('INVALID_ARGUMENT');
  });

  it('reports a throwing callback without stopping delivery', async () => {
    let calls = 0;
    const subscribing = peripheral.subscribeBatched(
      TEST_SERVICE,
      STREAM,
      () => {
        calls++;
        throw new Error('app bug');
      },
      { intervalMs: 16 }
    );
    await tick(10);
    await subscribing;
    const thrown: unknown[] = [];
    for (const n of [1, 2]) {
      send(n);
      await tick(16).catch((error: unknown) => thrown.push(error));
      await tick(1).catch((error: unknown) => thrown.push(error));
    }
    expect(calls).toBe(2);
    expect(thrown.map((error) => (error as Error).message)).toEqual(['app bug', 'app bug']);
  });
});
