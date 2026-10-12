import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { startDemo } from '../demo/testPeripheral';
import { TestProfile } from '../lib/gattNames';
import { PhoneAsPeripheralScreen } from '../screens/PhoneAsPeripheralScreen';

// P4-05: the Peripheral tab against the fake: one switch opens the server and advertises; a
// virtual central reads the TEST service and gets heart-rate measurements. P5-03: it reads the L2CAP
// echo server's PSM, and the server echoes.

const settle = (ms = 100) => act(() => jest.advanceTimersByTimeAsync(ms));

describe('Peripheral tab', () => {
  let demo: ReturnType<typeof startDemo>;

  beforeEach(() => {
    jest.useFakeTimers();
    demo = startDemo(1);
  });

  afterEach(() => {
    demo.stop();
    jest.useRealTimers();
  });

  it('serves and advertises the test profile while switched on', async () => {
    await render(<PhoneAsPeripheralScreen />);
    await fireEvent(screen.getByTestId('peripheral-switch'), 'valueChange', true);
    await settle();
    expect(
      screen.getByText('Advertising as the test peripheral, L2CAP echo on PSM 0x80')
    ).toBeTruthy();
    expect(demo.ble.advertisement?.data.serviceUUIDs).toEqual([
      TestProfile.TEST,
      TestProfile.HEART_RATE,
    ]);

    const phone = demo.ble.connectCentral({ id: 'AA:BB:CC:DD:EE:FF' });
    const read = phone.read(TestProfile.STATIC_READ);
    await settle();
    expect(await read).toHaveLength(20);
    const subscribe = phone.subscribe(TestProfile.HEART_RATE_MEASUREMENT);
    await settle(2100);
    await subscribe;
    const bpm = phone.notifications.map((n) => n.value[1]);
    expect(bpm.length).toBeGreaterThanOrEqual(2);
    expect(bpm[1]).toBe(bpm[0] + 1);
    expect(screen.getByText('Centrals: EE:FF')).toBeTruthy();

    const psm = phone.read(TestProfile.L2CAP_PSM);
    await settle();
    expect([...(await psm)]).toEqual([0x80, 0]);
    const opening = demo.ble.openL2CAPChannel(0x80, { centralId: 'AA:BB:CC:DD:EE:FF' });
    await settle();
    const channel = await opening;
    const echoed: number[] = [];
    channel.onData((data) => echoed.push(...data));
    channel.write(Uint8Array.of(1, 2, 3));
    await settle();
    expect(echoed).toEqual([1, 2, 3]);

    await fireEvent(screen.getByTestId('peripheral-switch'), 'valueChange', false);
    await settle();
    expect(screen.getByText('Off')).toBeTruthy();
    expect(demo.ble.advertisement).toBeNull();
    expect(() => demo.ble.connectCentral()).toThrow();
    expect(channel.isOpen).toBe(false);
  });

  it("switches back off when it can't start", async () => {
    demo.ble.injectError({ op: 'startAdvertising' }, 'NOT_SUPPORTED');
    await render(<PhoneAsPeripheralScreen />);
    await fireEvent(screen.getByTestId('peripheral-switch'), 'valueChange', true);
    await settle();
    expect(screen.getByText(/^NOT_SUPPORTED/)).toBeTruthy();
    expect(screen.getByTestId('peripheral-switch').props.value).toBe(false);
    expect(() => demo.ble.connectCentral()).toThrow(); // the server closed again
  });
});
