import { BleManager, type Peripheral } from 'expo-ble-kit';

import { startDemo } from '../demo/testPeripheral';
import { describeServiceChange, runConnectCycles, runServiceChange } from '../lib/gattHygiene';

// P2-06: a service change on the virtual test peripheral, and connect/disconnect cycles.

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

describe('GATT hygiene', () => {
  let demo: ReturnType<typeof startDemo>;
  let peripheral: Peripheral;

  beforeEach(async () => {
    jest.useFakeTimers();
    demo = startDemo(1);
    peripheral = BleManager.getPeripheral(demo.device.id);
    await settle(peripheral.connect());
  });

  afterEach(() => {
    demo.stop();
    jest.useRealTimers();
  });

  it('toggling the secondary service emits servicesChanged with the new services', async () => {
    const report = await settle(runServiceChange(peripheral));
    expect(report.toggles.map((toggle) => toggle.present)).toEqual([true, false]);
    expect(report.toggles.every((toggle) => toggle.ms !== null)).toBe(true);
    expect(report.readWhilePresent).toBe(true);
    expect(report.ok).toBe(true);
    expect(describeServiceChange(report)).toMatch(/^Service change OK: added → servicesChanged/);
  });

  it('connects and disconnects 50 times without a failure', async () => {
    const progress: number[] = [];
    const report = await settle(runConnectCycles(peripheral, 50, (done) => progress.push(done)));
    expect(report).toMatchObject({ cycles: 50, failures: 0, ok: true });
    expect(progress).toEqual([10, 20, 30, 40, 50]);
    expect(peripheral.state).toBe('disconnected');
  });
});
