import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { startDemo } from '../demo/testPeripheral';
import { BackgroundScanChecks } from '../screens/BackgroundScanChecks';

// P3-04: the Background scan group. The scan runs natively; demo mode checks the registration.

describe('Background scan checks', () => {
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

  it('registers and unregisters the task', async () => {
    await render(<BackgroundScanChecks />);
    expect(screen.getByText('No delivery in this process yet')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('background-scan-apple'));
    expect(await screen.findByText(/^Register \(apple\): ok/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('background-scan-unregister'));
    expect(await screen.findByText(/^Unregister: ok/)).toBeTruthy();
  });

  it('is not supported on iOS yet', async () => {
    Platform.OS = 'ios';
    await render(<BackgroundScanChecks />);
    await fireEvent.press(screen.getByTestId('background-scan-test'));
    expect(await screen.findByText(/^Register \(test\): NOT_SUPPORTED/)).toBeTruthy();
  });
});
