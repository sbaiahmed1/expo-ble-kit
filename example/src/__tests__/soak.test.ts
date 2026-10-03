import { BleManager, type Peripheral } from 'expo-ble-kit';

import { runningDemo, startDemo } from '../demo/testPeripheral';
import { TestProfile } from '../lib/gattNames';
import { describeLongScan, describeToggleSoak, runLongScan, runToggleSoak } from '../lib/soak';

// P2-09: the soak suite's in-app checks against the virtual test peripheral.

async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true)
  );
  for (let ms = 0; !done && ms < 3_600_000; ms += 100) {
    await jest.advanceTimersByTimeAsync(100);
  }
  return promise;
}

const ABSENT_ID = 'C0:FF:EE:00:00:99';

describe('soak suite', () => {
  let demo: ReturnType<typeof startDemo>;

  beforeEach(() => {
    jest.useFakeTimers();
    demo = startDemo(1);
  });

  afterEach(() => {
    demo.stop();
    jest.useRealTimers();
  });

  const toggle = (on: boolean) => runningDemo()!.setState(on ? 'poweredOn' : 'poweredOff');

  it('every operation settles with a code when Bluetooth goes off, right away', async () => {
    const report = await settle(
      runToggleSoak({
        absent: BleManager.getPeripheral(ABSENT_ID),
        peripheral: BleManager.getPeripheral(demo.device.id),
        signal: new AbortController().signal,
        toggle,
        toggles: 5,
      })
    );
    expect(report).toMatchObject({ offs: 5, uncoded: [], late: [], unsettled: [], ok: true });
    expect(report.codes.BLUETOOTH_POWERED_OFF).toBeGreaterThanOrEqual(5);
    expect(report.scanEnds.BLUETOOTH_POWERED_OFF).toBe(5);
    expect(report.succeeded).toBeGreaterThan(50);
    expect(describeToggleSoak(report)).toMatch(/^Toggle soak OK: 5 offs, \d+ ops/);
    expect(BleManager.state).toBe('poweredOn');
  });

  it('reports an operation that never settles, and too few offs', async () => {
    const real = BleManager.getPeripheral(ABSENT_ID);
    const stuck = {
      connect: () => new Promise(() => {}),
      disconnect: () => real.disconnect(),
    } as unknown as Peripheral;
    const report = await settle(
      runToggleSoak({ absent: stuck, signal: new AbortController().signal, toggle, toggles: 2 })
    );
    expect(report.unsettled).toEqual([expect.stringMatching(/^connect \(absent\), pending for/)]);
    expect(report.late).toEqual([]); // still pending, so never late
    expect(report.ok).toBe(false);

    const controller = new AbortController();
    const short = runToggleSoak({ absent: real, signal: controller.signal, minOffs: 50 });
    await jest.advanceTimersByTimeAsync(2_000);
    controller.abort();
    expect((await settle(short)).ok).toBe(false);
  });

  it('a long filtered scan gets results every minute, and an empty minute fails it', async () => {
    // Real peripherals repeat their advertisement; the virtual one does when told to.
    const advertising = setInterval(() => demo.device.advertise(true), 1_000);
    const filter = { label: 'TEST service', options: { services: [TestProfile.TEST] } };
    const report = await settle(runLongScan({ filter, minutes: 3 }));
    expect(report.perMinute).toHaveLength(3);
    expect(report.perMinute.every((count) => count >= 50)).toBe(true);
    expect(report).toMatchObject({ emptyMinutes: [], error: null, ok: true });
    expect(describeLongScan(report)).toMatch(/^Long scan OK: TEST service, 3 \/ 3 min/);

    const quiet = runLongScan({ filter, minutes: 3 });
    await jest.advanceTimersByTimeAsync(58_500); // results arrive in 1 s batches
    clearInterval(advertising);
    demo.device.advertise(false);
    const failed = await settle(quiet);
    expect(failed.emptyMinutes).toEqual([2, 3]);
    expect(failed.ok).toBe(false);
  });

  it('a long scan that the adapter ends fails with the code', async () => {
    const filter = { label: 'TEST service', options: { services: [TestProfile.TEST] } };
    const run = runLongScan({ filter, minutes: 45 });
    await jest.advanceTimersByTimeAsync(1_000);
    toggle(false);
    const report = await settle(run);
    expect(report.error).toMatch(/^BLUETOOTH_POWERED_OFF/);
    expect(describeLongScan(report)).toMatch(/FAILED.*ended by BLUETOOTH_POWERED_OFF/);
    toggle(true);
  });
});
