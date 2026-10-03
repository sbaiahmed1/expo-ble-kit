import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { startDemo } from '../demo/testPeripheral';
import { TestProfile } from '../lib/gattNames';
import { ExplorerScreen } from '../screens/ExplorerScreen';

// P1-15: the Explorer against the virtual test peripheral (built from profile.json).

const settle = (ms = 100) => act(() => jest.advanceTimersByTimeAsync(ms));

describe('Explorer', () => {
  let demo: ReturnType<typeof startDemo>;

  beforeEach(() => {
    jest.useFakeTimers();
    demo = startDemo();
  });

  afterEach(() => {
    demo.stop();
    jest.useRealTimers();
  });

  async function openTestPeripheral() {
    await render(<ExplorerScreen />);
    await settle();
    await fireEvent.press(screen.getByLabelText('BleKit-Test'));
    await fireEvent.press(screen.getByTestId('connect'));
    await settle();
    expect(screen.getByText('Connected · MTU 247')).toBeTruthy();
  }

  it('lists the test peripheral and its services once connected', async () => {
    await openTestPeripheral();
    expect(screen.getByText('TEST service')).toBeTruthy();
    expect(screen.getByText('Heart Rate')).toBeTruthy();
    expect(screen.getByText('STATIC_READ')).toBeTruthy();
  });

  it('reads, with hex and UTF-8 views', async () => {
    await openTestPeripheral();
    await fireEvent.press(screen.getByTestId(`read-${TestProfile.STATIC_READ}`));
    await settle();
    expect(
      screen.getByText('00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f 10 11 12 13')
    ).toBeTruthy();
    expect(screen.getByText('20 bytes')).toBeTruthy();
  });

  it('writes text or hex and reads it back', async () => {
    await openTestPeripheral();
    await fireEvent.changeText(
      screen.getByTestId(`write-input-${TestProfile.ECHO_WRITE}`),
      'hello'
    );
    await fireEvent.press(screen.getByTestId(`write-${TestProfile.ECHO_WRITE}`));
    await settle();
    expect(screen.getByText('Wrote 5 bytes')).toBeTruthy();
    await fireEvent.press(screen.getByTestId(`read-${TestProfile.ECHO_READ}`));
    await settle();
    expect(screen.getByText('68 65 6c 6c 6f')).toBeTruthy();
    expect(screen.getByText('"hello"')).toBeTruthy();

    await fireEvent.press(screen.getByTestId(`write-mode-${TestProfile.ECHO_WRITE}`));
    await fireEvent.changeText(screen.getByTestId(`write-input-${TestProfile.ECHO_WRITE}`), 'zz');
    await fireEvent.press(screen.getByTestId(`write-${TestProfile.ECHO_WRITE}`));
    await settle();
    expect(screen.getByTestId(`error-${TestProfile.ECHO_WRITE}`)).toBeTruthy();
    expect(screen.getByText(/Hex needs pairs/)).toBeTruthy();
  });

  it('subscribes to notifications and unsubscribes', async () => {
    await openTestPeripheral();
    const measurement = TestProfile.HEART_RATE_MEASUREMENT;
    await fireEvent.press(screen.getByTestId(`subscribe-${measurement}`));
    await settle();
    await settle(2000);
    expect(screen.getByText('Subscribed (2)')).toBeTruthy();
    expect(screen.getByText('00 3d')).toBeTruthy(); // 61 bpm: the second reading
    await fireEvent.press(screen.getByTestId(`subscribe-${measurement}`));
    await settle();
    expect(demo.device.isNotifying(TestProfile.HEART_RATE, measurement)).toBe(false);
  });

  it('reads descriptors, the RSSI, and disconnects', async () => {
    await openTestPeripheral();
    await fireEvent.press(screen.getByTestId('read-00002901-0000-1000-8000-00805f9b34fb'));
    await settle();
    expect(screen.getByText('"Stream"')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('read-rssi'));
    await settle();
    expect(screen.getByText('Connected · MTU 247 · RSSI -60 dBm')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('disconnect'));
    await settle();
    expect(screen.getByTestId('connect')).toBeTruthy();
    expect(screen.queryByText('TEST service')).toBeNull();
  });
});
