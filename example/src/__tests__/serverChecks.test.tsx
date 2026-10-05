import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { startDemo } from '../demo/testPeripheral';
import { TestProfile } from '../lib/gattNames';
import { streamFrame } from '../lib/serverProfile';
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
    operation.catch(() => {}); // a rejection is the caller's to check, after the ticks
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
    await central(
      phone.write(TestProfile.SINK_NO_RSP, new Uint8Array(20), { withResponse: false })
    );
    expect(await central(phone.read(TestProfile.SINK_COUNTER))).toEqual(Uint8Array.of(20, 0, 0, 0));
    await central(phone.subscribe(TestProfile.STREAM));
    expect(screen.getByText(/subscribed to STREAM: EE:FF/)).toBeTruthy();
    expect(screen.getByText(/read LONG_READ from EE:FF at 0/)).toBeTruthy();

    await fireEvent.press(screen.getByTestId('server-close'));
    await settle();
    expect(screen.getByText('Server closed')).toBeTruthy();
  });

  it('streams and indicates on CONTROL commands (P4-02)', async () => {
    await render(<ServerChecks />);
    await settle();
    await fireEvent.press(screen.getByTestId('server-open'));
    await settle();
    const phone = demo.ble.connectCentral({ id: 'AA:BB:CC:DD:EE:FF' });
    const control = (...bytes: number[]) =>
      central(phone.write(TestProfile.CONTROL, Uint8Array.from(bytes)));

    await central(phone.subscribe(TestProfile.STREAM));
    await control(1, 100, 0, 20, 0); // SET_STREAM 100 Hz, 20 B
    await settle(1000);
    await control(1, 0, 0, 20, 0);
    const frames = phone.notifications.filter((n) => n.characteristic === TestProfile.STREAM);
    expect(frames.length).toBeGreaterThanOrEqual(100);
    expect(frames.length).toBeLessThanOrEqual(112);
    frames.forEach(({ value }, seq) => expect(value).toEqual(streamFrame(seq, 20)));

    await control(4); // RESET_COUNTERS
    await central(phone.subscribe(TestProfile.INDICATE, 'indicate'));
    await control(5, 3, 0); // SEND_INDICATIONS 3
    await settle();
    expect(
      phone.notifications
        .filter((n) => n.characteristic === TestProfile.INDICATE)
        .map((n) => [n.value[0], n.indication])
    ).toEqual([
      [0, true],
      [1, true],
      [2, true],
    ]);
    await expect(control(9)).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    await expect(control(1, 100)).rejects.toMatchObject({ code: 'INVALID_ATTRIBUTE_LENGTH' });

    await fireEvent.press(screen.getByTestId('server-close'));
    await settle();
  });

  it('advertises the TEST service until stopped (P4-03)', async () => {
    await render(<ServerChecks />);
    await settle();
    await fireEvent.press(screen.getByTestId('advertising-start'));
    await settle();
    expect(screen.getByText('Advertising the TEST service')).toBeTruthy();
    expect(demo.ble.advertisement?.data).toMatchObject({
      localName: 'BleKit-Test',
      serviceUUIDs: [TestProfile.TEST],
    });
    await fireEvent.press(screen.getByTestId('advertising-stop'));
    await settle();
    expect(screen.getByText('Not advertising')).toBeTruthy();
    expect(demo.ble.advertisement).toBeNull();
  });
});
