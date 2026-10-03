import { BleManager, type Peripheral } from 'expo-ble-kit';

import { startDemo } from '../demo/testPeripheral';
import { runBatchedStream } from '../lib/batchedStream';

// P2-04: the virtual test peripheral streams 100 Hz × 20 B frames to a batched subscription.

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

describe('batched stream', () => {
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

  it('gets every frame in order, at most ~63 batches a second, nothing dropped', async () => {
    const updates: number[] = [];
    const report = await settle(
      runBatchedStream(peripheral, { seconds: 10, onUpdate: (r) => updates.push(r.frames) })
    );
    expect(report.frames).toBeGreaterThanOrEqual(990);
    expect(report.gaps).toBe(0);
    expect(report.dropped).toBe(0);
    expect(report.batchesPerSecond).toBeLessThanOrEqual(63);
    expect(report.ok).toBe(true);
    expect(updates).toHaveLength(10);
    expect(
      demo.device.isNotifying(
        '0c6c1000-b347-4cfa-9827-1c5a13658519',
        '0c6c1007-b347-4cfa-9827-1c5a13658519'
      )
    ).toBe(false);
  });

  it('stops early on abort', async () => {
    const controller = new AbortController();
    const running = runBatchedStream(peripheral, {
      seconds: 60,
      signal: controller.signal,
      onUpdate: (r) => {
        if (r.seconds >= 2) controller.abort();
      },
    });
    const report = await settle(running);
    expect(report.seconds).toBeLessThan(3);
    expect(report.ok).toBe(true);
  });
});
