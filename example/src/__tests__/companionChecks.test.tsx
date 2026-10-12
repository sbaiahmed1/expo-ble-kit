import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { startDemo } from '../demo/testPeripheral';
import { CompanionChecks } from '../screens/CompanionChecks';

// P5-05: the Companion device group against the demo, whose virtual test peripheral is what the
// person picks. Presence comes from Android's service, so demo mode checks the registration.

describe('Companion device checks', () => {
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

  it('associates the test peripheral and registers the presence task', async () => {
    await render(<CompanionChecks />);
    expect(screen.getByText('No presence change in this process yet')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('companion-associate'));
    expect(
      await screen.findByText(new RegExp(`^Associate: associated ${demo.device.id}`))
    ).toBeTruthy();
    await fireEvent.press(screen.getByTestId('companion-register'));
    expect(await screen.findByText(/^Register: ok/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('companion-unregister'));
    expect(await screen.findByText(/^Unregister: ok/)).toBeTruthy();
  });

  it('shows nothing on iOS', async () => {
    Platform.OS = 'ios';
    await render(<CompanionChecks />);
    expect(screen.queryByTestId('companion-associate')).toBeNull();
  });
});
