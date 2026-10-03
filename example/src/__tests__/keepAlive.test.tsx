import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { BleManager } from 'expo-ble-kit';

import { startDemo } from '../demo/testPeripheral';
import { KeepAliveChecks } from '../screens/KeepAliveChecks';

// P3-03: the Keep alive group. The service itself runs natively; demo mode checks the screen.

describe('Keep alive checks', () => {
  const platform = Platform.OS;
  let demo: ReturnType<typeof startDemo>;

  beforeEach(() => {
    Platform.OS = 'android';
    demo = startDemo(1);
  });

  afterEach(() => {
    demo.stop();
    Platform.OS = platform;
  });

  it('sets the notification text', async () => {
    const set = jest.spyOn(BleManager.android, 'setForegroundServiceNotification');
    await render(<KeepAliveChecks />);
    await fireEvent.press(screen.getByTestId('keep-alive-notification'));
    expect(set).toHaveBeenCalledWith({
      title: 'expo-ble-kit example',
      text: expect.stringMatching(/^Waiting for /),
    });
    expect(await screen.findByText(/^Notification set; state disconnected/)).toBeTruthy();
  });

  it('connects with keep-alive and disconnects', async () => {
    await render(<KeepAliveChecks />);
    await fireEvent.press(screen.getByTestId('keep-alive-connect'));
    expect(await screen.findByText(/^Keep-alive connect; state connecting/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('keep-alive-disconnect'));
    // The cancelled connect reports too; either way the device ends disconnected.
    expect(await screen.findByText(/; state disconnected, foreground service/)).toBeTruthy();
  });
});
