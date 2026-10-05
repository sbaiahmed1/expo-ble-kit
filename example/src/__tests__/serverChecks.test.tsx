import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { startDemo } from '../demo/testPeripheral';
import { TestProfile } from '../lib/gattNames';
import { ServerChecks } from '../screens/ServerChecks';

// P4-01: the GATT server group against the fake, with a virtual central reading and writing.

const settle = (ms = 100) => act(() => jest.advanceTimersByTimeAsync(ms));

describe('GATT server checks', () => {
  let demo: ReturnType<typeof startDemo>;

  beforeEach(() => {
    jest.useFakeTimers();
    demo = startDemo(1);
  });

  afterEach(() => {
    demo.stop();
    jest.useRealTimers();
  });

  /** A central operation, answered on later ticks. */
  async function central<T>(operation: Promise<T>): Promise<T> {
    await settle();
    return operation;
  }

  it('serves the test profile: one consistent long read, echo, sink counter', async () => {
    await render(<ServerChecks />);
    await settle();
    await fireEvent.press(screen.getByTestId('server-open'));
    await settle();
    expect(screen.getByText(/^Server open: TEST service/)).toBeTruthy();
    const phone = demo.ble.connectCentral({ id: 'AA:BB:CC:DD:EE:FF' });

    const first = await central(phone.read(TestProfile.LONG_READ));
    const second = await central(phone.read(TestProfile.LONG_READ));
    expect(first).toHaveLength(512);
    // Each read is one handler result (one shift), the next read the next one.
    expect(second.every((byte, i) => byte === ((first[i] + 1) & 0xff))).toBe(true);

    await central(phone.write(TestProfile.ECHO_WRITE, Uint8Array.of(1, 2, 3)));
    expect(await central(phone.read(TestProfile.ECHO_READ))).toEqual(Uint8Array.of(1, 2, 3));
    await central(phone.write(TestProfile.SINK_NO_RSP, new Uint8Array(20), { withResponse: false }));
    expect(await central(phone.read(TestProfile.SINK_COUNTER))).toEqual(Uint8Array.of(20, 0, 0, 0));
    await central(phone.subscribe(TestProfile.STREAM));
    expect(screen.getByText(/subscribed to STREAM: EE:FF/)).toBeTruthy();
    expect(screen.getByText(/read LONG_READ from EE:FF at 0/)).toBeTruthy();

    await fireEvent.press(screen.getByTestId('server-close'));
    await settle();
    expect(screen.getByText('Server closed')).toBeTruthy();
  });
});
