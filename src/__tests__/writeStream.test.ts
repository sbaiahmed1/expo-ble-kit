import { BleError, BleManager, type Peripheral } from '../index';
import { installFakeBle, type FakeBle, type VirtualPeripheral } from '../testing';

// P2-03: Peripheral.writeStream over the fake adapter, which chunks like the native cores.

const TEST_SERVICE = '0c6c1000-b347-4cfa-9827-1c5a13658519';
const STATIC_READ = '0c6c1001-b347-4cfa-9827-1c5a13658519';
const ECHO_WRITE = '0c6c1003-b347-4cfa-9827-1c5a13658519';
const SINK = '0c6c1005-b347-4cfa-9827-1c5a13658519';

const profile = {
  name: 'BleKit-Test',
  mtu: 247,
  services: [
    {
      uuid: TEST_SERVICE,
      characteristics: [
        { uuid: STATIC_READ, properties: ['read' as const], value: new Uint8Array([1, 2, 3]) },
        { uuid: ECHO_WRITE, properties: ['write' as const] },
        { uuid: SINK, properties: ['writeWithoutResponse' as const] },
      ],
    },
  ],
};

/** Runs fake timers until `promise` settles. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true)
  );
  for (let ms = 0; !done && ms < 600_000; ms += 10) {
    await jest.advanceTimersByTimeAsync(10);
  }
  return promise;
}

async function errorOf(promise: Promise<unknown>): Promise<BleError> {
  const error = await settle(promise).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(BleError);
  return error as BleError;
}

describe('writeStream', () => {
  let fake: FakeBle;
  let device: VirtualPeripheral;
  let peripheral: Peripheral;
  const writes = (characteristic: string) =>
    device.writes.filter((write) => write.characteristic === characteristic);

  beforeEach(async () => {
    jest.useFakeTimers();
    fake = installFakeBle();
    device = fake.addPeripheral(profile);
    peripheral = BleManager.getPeripheral(device.id);
    await settle(peripheral.connect());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('writes 1 MB in packets of MTU − 3 without response, in order, with progress', async () => {
    const data = Uint8Array.from({ length: 1 << 20 }, (_, i) => (i * 7) % 256);
    const progress: number[][] = [];
    await settle(
      peripheral.writeStream(TEST_SERVICE, SINK, data, {
        onProgress: (sent, total) => progress.push([sent, total]),
      })
    );
    const packets = writes(SINK);
    expect(packets.every((write) => !write.withResponse && write.value.length <= 244)).toBe(true);
    expect(packets).toHaveLength(Math.ceil((1 << 20) / 244));
    const received = new Uint8Array(1 << 20);
    let offset = 0;
    for (const { value } of packets) {
      received.set(value, offset);
      offset += value.length;
    }
    expect(received).toEqual(data);
    expect(progress.at(-1)).toEqual([1 << 20, 1 << 20]);
    expect(progress.length).toBeGreaterThanOrEqual(90);
    expect(progress.length).toBeLessThanOrEqual(101);
  });

  it('writes with response in chunks of a given size', async () => {
    const progress: number[] = [];
    await settle(
      peripheral.writeStream(TEST_SERVICE, ECHO_WRITE, new Uint8Array(1000), {
        withResponse: true,
        chunkSize: 300,
        onProgress: (sent) => progress.push(sent),
      })
    );
    expect(writes(ECHO_WRITE).map((write) => [write.value.length, write.withResponse])).toEqual([
      [300, true],
      [300, true],
      [300, true],
      [100, true],
    ]);
    expect(progress).toEqual([300, 600, 900, 1000]);
  });

  it('keeps its place: operations issued meanwhile wait for the end of the stream', async () => {
    const order: string[] = [];
    const stream = peripheral
      .writeStream(TEST_SERVICE, SINK, new Uint8Array(244 * 5))
      .then(() => order.push(`stream after ${writes(SINK).length} chunks`));
    const read = peripheral
      .read(TEST_SERVICE, STATIC_READ)
      .then(() => order.push(`read after ${writes(SINK).length} chunks`));
    await settle(Promise.all([stream, read]));
    expect(order).toEqual(['stream after 5 chunks', 'read after 5 chunks']);
  });

  it('an abort stops the stream within the chunk in flight', async () => {
    const controller = new AbortController();
    const stream = peripheral.writeStream(TEST_SERVICE, SINK, new Uint8Array(244 * 100), {
      signal: controller.signal,
      onProgress: (sent) => {
        if (sent >= 244 * 10) controller.abort();
      },
    });
    const error = await errorOf(stream);
    expect(error.code).toBe('OPERATION_CANCELLED');
    const written = writes(SINK).length;
    expect(written).toBeLessThanOrEqual(12);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(writes(SINK).length).toBe(written);
  });

  it('an already aborted signal writes nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await errorOf(
      peripheral.writeStream(TEST_SERVICE, SINK, new Uint8Array(100), {
        signal: controller.signal,
      })
    );
    expect(error.code).toBe('OPERATION_CANCELLED');
    expect(writes(SINK)).toHaveLength(0);
  });

  it('rejects with the first failed chunk, saying how far it got', async () => {
    fake.injectError({ op: 'write', characteristic: ECHO_WRITE }, 'WRITE_NOT_PERMITTED');
    const error = await errorOf(
      peripheral.writeStream(TEST_SERVICE, ECHO_WRITE, new Uint8Array(100), {
        withResponse: true,
      })
    );
    expect(error.code).toBe('WRITE_NOT_PERMITTED');
    expect(error.message).toContain('after 0 of 100 bytes');
    expect(error.characteristicUUID).toBe(ECHO_WRITE);
  });

  it('a disconnect rejects the stream', async () => {
    const stream = peripheral.writeStream(TEST_SERVICE, SINK, new Uint8Array(244 * 100), {
      onProgress: () => device.disconnect(),
    });
    expect((await errorOf(stream)).code).toBe('DISCONNECTED');
  });

  it('validates its input', async () => {
    const codeOf = async (promise: Promise<unknown>) => (await errorOf(promise)).code;
    const data = new Uint8Array(10);
    expect(await codeOf(peripheral.writeStream(TEST_SERVICE, SINK, [1, 2] as never))).toBe(
      'INVALID_ARGUMENT'
    );
    expect(await codeOf(peripheral.writeStream(TEST_SERVICE, SINK, data, { chunkSize: 0 }))).toBe(
      'INVALID_ARGUMENT'
    );
    expect(await codeOf(peripheral.writeStream(TEST_SERVICE, SINK, data, { chunkSize: 245 }))).toBe(
      'INVALID_ARGUMENT'
    );
    expect(
      await codeOf(peripheral.writeStream(TEST_SERVICE, SINK, data, { onProgress: 1 as never }))
    ).toBe('INVALID_ARGUMENT');
    expect(await codeOf(peripheral.writeStream(TEST_SERVICE, ECHO_WRITE, data))).toBe(
      'WRITE_NOT_PERMITTED'
    );
    expect(await codeOf(peripheral.writeStream(TEST_SERVICE, SINK, data, { timeoutMs: 0 }))).toBe(
      'INVALID_ARGUMENT'
    );
  });

  it('empty data resolves without writing or reporting progress', async () => {
    const onProgress = jest.fn();
    await settle(peripheral.writeStream(TEST_SERVICE, SINK, new Uint8Array(0), { onProgress }));
    expect(writes(SINK)).toHaveLength(0);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('a throwing progress callback does not stop the stream', async () => {
    const stream = peripheral.writeStream(TEST_SERVICE, SINK, new Uint8Array(1000), {
      onProgress: () => {
        throw new Error('app bug');
      },
    });
    let done = false;
    stream.then(() => (done = true));
    const thrown: unknown[] = [];
    while (!done) {
      // The callback's error is rethrown on a later tick, like a listener's.
      await jest.advanceTimersByTimeAsync(10).catch((error: unknown) => thrown.push(error));
    }
    expect(thrown.length).toBeGreaterThan(0);
    expect(thrown.every((error) => (error as Error).message === 'app bug')).toBe(true);
    expect(writes(SINK).reduce((sum, write) => sum + write.value.length, 0)).toBe(1000);
  });
});
