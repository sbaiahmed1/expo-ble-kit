import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { installFakeBle } from 'expo-ble-kit/testing';

import App from '../../App';

const settle = (ms = 100) => act(() => jest.advanceTimersByTimeAsync(ms));

describe('the example app', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('switches tabs, and demo mode shows the virtual test peripheral', async () => {
    installFakeBle(); // stands in for the native module, which Jest doesn't have
    await render(<App />);
    await settle();
    expect(screen.queryByLabelText('BleKit-Test')).toBeNull();

    await fireEvent(screen.getByTestId('demo-mode'), 'valueChange', true);
    await settle();
    expect(screen.getByLabelText('BleKit-Test')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('tab-heart-rate'));
    await settle();
    expect(screen.getByLabelText('BleKit-Test')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('tab-checks'));
    expect(screen.getByText('Connecting')).toBeTruthy();
  });
});
