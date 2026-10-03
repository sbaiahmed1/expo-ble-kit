import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { startDemo } from '../demo/testPeripheral';
import { TestProfile } from '../lib/gattNames';
import { HeartRateScreen } from '../screens/HeartRateScreen';

// P1-15: Heart Rate against the virtual test peripheral: live BPM and reconnection (P2-01).

const settle = (ms = 100) => act(() => jest.advanceTimersByTimeAsync(ms));
const status = () => screen.getByTestId('hr-status').props.children;
const bpm = () => screen.getByTestId('bpm').props.children;

describe('Heart Rate', () => {
  let demo: ReturnType<typeof startDemo>;

  beforeEach(() => {
    jest.useFakeTimers();
    demo = startDemo();
  });

  afterEach(() => {
    demo.stop();
    jest.useRealTimers();
  });

  async function openMonitor() {
    await render(<HeartRateScreen />);
    await settle();
    await fireEvent.press(screen.getByLabelText('BleKit-Test'));
    await settle();
    expect(status()).toBe('Connected');
  }

  it('finds the monitor by its Heart Rate service and shows the live BPM', async () => {
    await openMonitor();
    expect(bpm()).toBe('--');
    await settle(1000);
    expect(bpm()).toBe(60);
    await settle(1000);
    expect(bpm()).toBe(61);
  });

  it('reconnects after a link loss and keeps counting', async () => {
    await openMonitor();
    await settle(1000);
    await act(async () => demo.device.disconnect('linkLoss'));
    expect(status()).toBe('Connection lost. Reconnecting…');
    await settle(1100);
    expect(status()).toBe('Connected');
    expect(screen.getByText('Reconnected 1×')).toBeTruthy();
    await settle(1000);
    expect(bpm()).toBe(61);
  });

  it('the test device can drop the link on request', async () => {
    await openMonitor();
    await fireEvent.press(screen.getByTestId('hr-drop'));
    await settle(600);
    expect(status()).toMatch(/Reconnecting/);
    await settle(1100);
    expect(status()).toBe('Connected');
  });

  it('gives up after five attempts, and tries again on request', async () => {
    await openMonitor();
    await act(async () => {
      demo.device.advertise(false);
      demo.device.disconnect('linkLoss');
    });
    // Waits of 1, 2, 4, 8 and 16 s, each followed by a 10 s connect timeout.
    await settle(31_000 + 5 * 10_000 - 200);
    expect(status()).toBe('Connection lost. Reconnecting…');
    await settle(400);
    expect(status()).toBe('Not connected: CONNECTION_TIMEOUT');

    await act(async () => demo.device.advertise(true));
    await fireEvent.press(screen.getByTestId('hr-retry'));
    await settle();
    expect(status()).toBe('Connected');
  });

  it('stops for good on disconnect', async () => {
    await openMonitor();
    await fireEvent.press(screen.getByTestId('hr-disconnect'));
    await settle(10_000);
    expect(status()).toBe('Not connected');
    expect(
      demo.device.isNotifying(TestProfile.HEART_RATE, TestProfile.HEART_RATE_MEASUREMENT)
    ).toBe(false);
  });
});
