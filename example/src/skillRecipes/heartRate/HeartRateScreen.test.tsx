import { act, render, screen, fireEvent } from '@testing-library/react-native';
import { GattCharacteristics, GattServices } from 'expo-ble-kit';
import { installFakeBle, type FakeBle } from 'expo-ble-kit/testing';

import { HeartRateScreen } from './HeartRateScreen';
import { parseHeartRate } from './parseHeartRate';

const settle = () => act(() => jest.advanceTimersByTimeAsync(100));

describe('HeartRateScreen', () => {
  let ble: FakeBle;

  beforeEach(() => {
    jest.useFakeTimers();
    ble = installFakeBle(); // powered on, permissions granted
  });

  afterEach(() => jest.useRealTimers());

  it('shows the strap’s heart rate', async () => {
    const strap = ble.addPeripheral({
      name: 'HRM',
      services: [
        {
          uuid: GattServices.HeartRate,
          characteristics: [{ uuid: GattCharacteristics.HeartRateMeasurement, properties: ['notify'] }],
        },
      ],
    });
    await render(<HeartRateScreen />); // Testing Library 14: render and fireEvent are async
    await settle();
    await fireEvent.press(screen.getByTestId('find-strap'));
    await settle(); // scan
    await settle(); // connect and discovery
    await settle(); // the hook subscribes once connected
    expect(strap.isNotifying(GattServices.HeartRate, GattCharacteristics.HeartRateMeasurement)).toBe(true);
    // The fake delivers the value at once: inside act, like any state change from a test.
    await act(async () =>
      strap.notify(GattServices.HeartRate, GattCharacteristics.HeartRateMeasurement, Uint8Array.of(0x06, 72))
    );
    expect(screen.getByText('72 bpm')).toBeTruthy();
  });

  it('parses a 16-bit rate, energy and RR intervals', () => {
    expect(parseHeartRate(Uint8Array.of(0x19, 0x2c, 0x01, 0x10, 0x00, 0x00, 0x04))).toEqual({
      bpm: 300,
      contact: null,
      energyKj: 16,
      rrMs: [1000],
    });
  });
});
