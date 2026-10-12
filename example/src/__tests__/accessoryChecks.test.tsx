import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Image, Platform } from 'react-native';

import { startDemo } from '../demo/testPeripheral';
import { AccessoryChecks } from '../screens/AccessoryChecks';

// P5-04: the picker check against the demo, where the virtual test peripheral is what gets picked.

const settle = (ms = 2000) => act(() => jest.advanceTimersByTimeAsync(ms));

describe('Accessory picker check', () => {
  let demo: ReturnType<typeof startDemo>;

  beforeEach(() => {
    jest.useFakeTimers();
    Platform.OS = 'ios';
    // A require()d image resolves to its URI in an app; Jest only has a stub for it.
    jest
      .spyOn(Image, 'resolveAssetSource')
      .mockReturnValue({ uri: 'file:///icon.png', width: 1, height: 1, scale: 1 });
    demo = startDemo(1);
  });

  afterEach(() => {
    demo.stop();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('picks the test peripheral, connects and reads', async () => {
    await render(<AccessoryChecks />);
    await fireEvent.press(screen.getByTestId('accessory-pick'));
    await settle();
    const log: string = screen.getByTestId('accessory-log').props.children;
    expect(log).toContain('Bluetooth permission before: granted');
    expect(log).toContain(`Picked ${demo.device.id}`);
    expect(log).toMatch(/Connected: \d+ services\nRead 1001: 00 01 02/);
  });
});
