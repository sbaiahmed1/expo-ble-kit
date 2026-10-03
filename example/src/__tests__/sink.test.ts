import { BleError, BleManager, type Peripheral } from 'expo-ble-kit';

import { startDemo } from '../demo/testPeripheral';
import { TestProfile } from '../lib/gattNames';
import { readSinkCounter, sendToSink } from '../lib/sink';

// P2-02: bytes sent through repeated writes without response all reach the peripheral's counter,
// here the virtual test peripheral's.

/** Runs fake timers until `promise` settles. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true)
  );
  for (let ms = 0; !done && ms < 600_000; ms += 50) {
    await jest.advanceTimersByTimeAsync(50);
  }
  return promise;
}

describe('sink', () => {
  let demo: ReturnType<typeof startDemo>;
  let peripheral: Peripheral;

  beforeEach(async () => {
    jest.useFakeTimers();
    demo = startDemo();
    peripheral = BleManager.getPeripheral(demo.device.id);
    await settle(peripheral.connect());
  });

  afterEach(() => {
    demo.stop();
    jest.useRealTimers();
  });

  it('counts every byte of 64 KB written without response', async () => {
    const progress: number[] = [];
    const report = await settle(sendToSink(peripheral, 65_536, (sent) => progress.push(sent)));
    expect(report).toMatchObject({ sent: 65_536, received: 65_536, packetSize: 244 });
    expect(progress.at(-1)).toBe(65_536);
    const writes = demo.device.writes.filter((w) => w.characteristic === TestProfile.SINK_NO_RSP);
    expect(writes.every((w) => !w.withResponse)).toBe(true);
    expect(writes.flatMap((w) => [...w.value])).toEqual(
      Array.from({ length: 65_536 }, (_, i) => i % 256)
    );
  });

  it('resets the counter before sending', async () => {
    await settle(sendToSink(peripheral, 1000));
    const report = await settle(sendToSink(peripheral, 500));
    expect(report.received).toBe(500);
    expect(await settle(readSinkCounter(peripheral))).toBe(500);
  });

  it('rejects with the first failed write', async () => {
    demo.ble.injectError({ op: 'write', characteristic: TestProfile.SINK_NO_RSP }, 'GATT_ERROR');
    const error = await settle(sendToSink(peripheral, 10_000)).catch((e: unknown) => e);
    expect(BleError.fromNative(error).code).toBe('GATT_ERROR');
  });
});
