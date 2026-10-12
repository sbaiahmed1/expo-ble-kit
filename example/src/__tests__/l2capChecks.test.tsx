import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { startDemo } from '../demo/testPeripheral';
import { echoPattern, describeEcho, runL2capEcho } from '../lib/l2capEcho';
import { L2capChecks } from '../screens/L2capChecks';
import { BleManager } from 'expo-ble-kit';

// P5-03: the L2CAP echo against the demo's virtual test peripheral, whose echo server sits at the
// profile's PSM (0x81).

const settle = (ms = 2000) => act(() => jest.advanceTimersByTimeAsync(ms));

async function finish<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  promise.finally(() => (done = true)).catch(() => {});
  while (!done) await jest.advanceTimersByTimeAsync(100);
  return promise;
}

describe('L2CAP checks', () => {
  let demo: ReturnType<typeof startDemo>;

  beforeEach(() => {
    jest.useFakeTimers();
    demo = startDemo(1);
  });

  afterEach(() => {
    demo.stop();
    jest.useRealTimers();
  });

  it('echoes the pattern and reports both directions', async () => {
    const device = BleManager.getPeripheral(demo.device.id);
    await finish(device.connect());
    const report = await finish(runL2capEcho(device, { bytes: 64 * 1024 }));
    expect(report).toMatchObject({ psm: 0x81, bytes: 64 * 1024, ok: true });
    expect(describeEcho(report)).toMatch(/^64 KB each way over PSM 0x81: sent in \d+\.\d s/);
    expect(describeEcho({ ...report, ok: false })).toBe(
      '64 KB each way over PSM 0x81: the echo differs from what was sent'
    );
    expect([...echoPattern(4)]).toEqual([7, 38, 69, 100]);
  });

  it('runs from the Checks screen', async () => {
    await render(<L2capChecks />);
    await fireEvent.press(screen.getByTestId('l2cap-echo'));
    await settle(10_000);
    expect(screen.getByTestId('l2cap-status').props.children).toMatch(
      /^1024 KB each way over PSM 0x81: sent in/
    );
  });
});
