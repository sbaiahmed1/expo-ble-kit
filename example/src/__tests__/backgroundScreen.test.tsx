import { render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { startDemo } from '../demo/testPeripheral';
import { BackgroundScreen } from '../screens/BackgroundScreen';

// P3-06: the Background tab lists the scenarios of the platform it runs on, with their controls.

describe('Background tab', () => {
  const platform = Platform.OS;
  let demo: ReturnType<typeof startDemo>;

  beforeEach(() => {
    demo = startDemo(1);
  });

  afterEach(() => {
    demo.stop();
    Platform.OS = platform;
  });

  it('shows the iOS scenarios with the restoration controls', async () => {
    Platform.OS = 'ios';
    await render(<BackgroundScreen />);
    for (const id of ['S-B1', 'S-B2', 'S-B6']) expect(screen.getByTestId(`scenario-${id}`)).toBeTruthy();
    expect(screen.queryByTestId('scenario-S-B3')).toBeNull();
    expect(screen.getByTestId('restoration-arm')).toBeTruthy();
  });

  it('shows the Android scenarios with their controls', async () => {
    Platform.OS = 'android';
    await render(<BackgroundScreen />);
    for (const id of ['S-B3', 'S-B4', 'S-B5', 'S-B6']) {
      expect(screen.getByTestId(`scenario-${id}`)).toBeTruthy();
    }
    expect(screen.queryByTestId('scenario-S-B1')).toBeNull();
    expect(screen.getByTestId('keep-alive-refresh')).toBeTruthy();
    expect(screen.getByTestId('background-scan-test')).toBeTruthy();
    expect(screen.getByTestId('companion-associate')).toBeTruthy();
  });
});
