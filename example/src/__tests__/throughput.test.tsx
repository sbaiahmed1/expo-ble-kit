import { render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { BleManager, type Peripheral } from 'expo-ble-kit';

import { startDemo } from '../demo/testPeripheral';
import {
  describeTransfer,
  notifications,
  writeWithResponse,
  writeWithoutResponse,
} from '../lib/throughput';
import { ThroughputScreen } from '../screens/ThroughputScreen';

// P2-08: the benchmark transfers against the virtual test peripheral (small sizes; the numbers that
// matter come from release builds on phones, docs/benchmarks.md).

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

describe('throughput', () => {
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

  it('writes without response through writeStream, confirmed by the peripheral counter', async () => {
    const result = await settle(writeWithoutResponse(peripheral, 64 << 10));
    expect(result).toMatchObject({ name: 'writeWithoutResponse', bytes: 65_536 });
    expect(result.note).toBe('244-byte packets, peripheral counted 65536');
    expect(describeTransfer(result)).toMatch(
      /^writeWithoutResponse: 65536 B in \d+\.\d{2} s = \d+\.\d KB\/s \(244-byte packets/
    );
  });

  it('writes with response, one packet per write', async () => {
    const result = await settle(writeWithResponse(peripheral, 16 << 10));
    expect(result).toMatchObject({
      name: 'writeWithResponse',
      bytes: 16_384,
      note: '244-byte packets',
    });
    const echoes = demo.device.writes.filter((w) => w.withResponse && w.value.length === 244);
    expect(echoes.length).toBe(Math.floor(16_384 / 244));
  });

  it('receives STREAM frames batched or one by one, without gaps', async () => {
    const batched = await settle(notifications(peripheral, { seconds: 2 }));
    expect(batched.name).toBe('notifications');
    expect(batched.bytes).toBeGreaterThan(0);
    expect(batched.note).toMatch(/ frames of 244 B, 0 gaps$/);
    const unbatched = await settle(notifications(peripheral, { seconds: 2, batched: false }));
    expect(unbatched.name).toBe('notificationsUnbatched');
    expect(unbatched.note).toMatch(/0 gaps, unbatched$/);
  });

  it('the screen offers the run and says what it needs', async () => {
    await render(<ThroughputScreen />);
    expect(screen.getByTestId('throughput-run')).toBeTruthy();
    expect(screen.getByTestId('throughput-status').props.children).toMatch(/BleKit-Test/);
    expect(screen.queryByTestId('throughput-fast-link')).toBeNull(); // iOS can't choose
  });

  it('on Android, the link can ask for 2M PHY and a high priority (P5-02)', async () => {
    Platform.OS = 'android';
    try {
      await render(<ThroughputScreen />);
      expect(screen.getByTestId('throughput-fast-link')).toBeTruthy();
      expect(await settle(peripheral.android.setPreferredPhy(['le2m'], ['le2m']))).toEqual({
        tx: 'le2m',
        rx: 'le2m',
      });
    } finally {
      Platform.OS = 'ios';
    }
  });
});
