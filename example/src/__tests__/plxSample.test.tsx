import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { BleManager } from 'expo-ble-kit/compat/plx';

import { startDemo } from '../demo/testPeripheral';
import { PlxChecks } from '../screens/PlxChecks';

// P6-01: the ble-plx sample against the demo's virtual test peripheral.

const settle = (ms = 3000) => act(() => jest.advanceTimersByTimeAsync(ms));

describe('ble-plx sample', () => {
  let demo: ReturnType<typeof startDemo>;

  beforeEach(() => {
    jest.useFakeTimers();
    demo = startDemo(1);
  });

  afterEach(async () => {
    const manager = BleManager.sharedInstance;
    if (manager) {
      const destroyed = manager.destroy();
      await act(() => jest.advanceTimersByTimeAsync(100));
      await destroyed;
    }
    demo.stop();
    jest.useRealTimers();
  });

  it('scans, connects, reads in base64 and gets a heart rate', async () => {
    await render(<PlxChecks />);
    await fireEvent.press(screen.getByTestId('plx-sample'));
    await settle();
    const log: string = screen.getByTestId('plx-log').props.children;
    expect(log).toMatch(
      /^Scanning for the TEST service…\nFound BleKit-Test, -60 dBm\n\d+ services, MTU \d+/
    );
    // STATIC_READ: bytes 0…19.
    expect(log).toContain('1001: AAECAwQFBgcICQoLDA0ODxAREhM=');
    expect(log).toMatch(/Heart rate \d+ bpm\nDone$/);
  });
});
