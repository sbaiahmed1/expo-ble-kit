import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { BleManager } from 'expo-ble-kit';
import { Platform } from 'react-native';

import { RESTORATION_TASK } from '../background/restorationTask';
import { startDemo } from '../demo/testPeripheral';
import { RestorationChecks } from '../screens/RestorationChecks';

// P3-01/P3-02: arming the restoration check against the demo registers the task, connects and
// keeps heart rate on; the fake has no restoration, which the journal says.

const settle = (ms = 3000) => act(() => jest.advanceTimersByTimeAsync(ms));

describe('State restoration check', () => {
  let demo: ReturnType<typeof startDemo>;

  beforeEach(() => {
    jest.useFakeTimers();
    Platform.OS = 'ios';
    demo = startDemo(1);
  });

  afterEach(() => {
    demo.stop();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('registers the task, connects and keeps heart rate on', async () => {
    const register = jest.spyOn(BleManager, 'registerBackgroundTask');
    await render(<RestorationChecks />);
    await fireEvent.press(screen.getByTestId('restoration-arm'));
    await settle();
    expect(register).toHaveBeenCalledWith(RESTORATION_TASK, {
      events: ['restored', 'connectionStateChange', 'notification'],
    });
    await expect(register.mock.results[0]?.value).resolves.toBeUndefined();
    expect(screen.getByTestId('restoration-status').props.children).toMatch(
      new RegExp(`Connected to ${demo.device.id}: \\d+ heart rate values`)
    );

    await fireEvent.press(screen.getByTestId('restoration-journal'));
    await settle(100);
    expect(screen.getByTestId('restoration-journal-lines').props.children).toBe(
      'Restoration is off in this build'
    );
  });
});
