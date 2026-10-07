import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { startDemo } from '../demo/testPeripheral';
import { BondingChecks } from '../screens/BondingChecks';

// P5-01: the bonding checks against the demo's virtual test peripheral (the fake doesn't encrypt,
// so SECURE reads at once; on a phone the read pairs first).

const settle = (ms = 2000) => act(() => jest.advanceTimersByTimeAsync(ms));

describe('Bonding checks', () => {
  let demo: ReturnType<typeof startDemo>;

  beforeEach(() => {
    jest.useFakeTimers();
    demo = startDemo(1);
  });

  afterEach(() => {
    demo.stop();
    jest.useRealTimers();
    Platform.OS = 'ios';
  });

  it('reads SECURE', async () => {
    await render(<BondingChecks />);
    await fireEvent.press(screen.getByTestId('bonding-read-secure'));
    await settle();
    expect(screen.getByText('SECURE read: "SECURE01"')).toBeTruthy();
  });

  it('bonds with createBond on Android', async () => {
    Platform.OS = 'android';
    await render(<BondingChecks />);
    await fireEvent.press(screen.getByTestId('bonding-create'));
    await settle();
    expect(screen.getByText('Bonded: bond bonded')).toBeTruthy();
  });
});
