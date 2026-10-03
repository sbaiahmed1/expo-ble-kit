import { startDemo } from '../demo/testPeripheral';
import { describeMultipleDevices, runMultipleDevices } from '../lib/multipleDevices';

// P2-05: the five virtual test peripherals of demo mode, connected at once; one drops itself.

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

describe('multiple devices', () => {
  let demo: ReturnType<typeof startDemo>;

  beforeEach(() => {
    jest.useFakeTimers();
    demo = startDemo();
  });

  afterEach(() => {
    demo.stop();
    jest.useRealTimers();
  });

  it('keeps the others streaming and answering when one drops', async () => {
    const report = await settle(runMultipleDevices({}));
    expect(report).toMatchObject({ found: 5, connected: 5, dropped: 'BleKit-Test', ok: true });
    expect(report.others.map((r) => r.name).sort()).toEqual([
      'BleKit-Test-2',
      'BleKit-Test-3',
      'BleKit-Test-4',
      'BleKit-Test-5',
    ]);
    expect(report.others.every((r) => r.after - r.before >= 50 && r.readOk)).toBe(true);
    expect(describeMultipleDevices(report)).toMatch(/^Multiple devices OK: 5 of 5 connected/);
  });

  it('is not OK with fewer devices than asked for', async () => {
    const report = await settle(runMultipleDevices({ minDevices: 6 }));
    expect(report.ok).toBe(false);
  });
});
