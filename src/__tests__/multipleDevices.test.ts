import { BleManager, type Peripheral } from '../index';
import { installFakeBle, type FakeBle, type VirtualPeripheral } from '../testing';

// P2-05: several connections at once through the public API, over the fake adapter.

const TEST_SERVICE = '0c6c1000-b347-4cfa-9827-1c5a13658519';
const STATIC_READ = '0c6c1001-b347-4cfa-9827-1c5a13658519';
const STREAM = '0c6c1007-b347-4cfa-9827-1c5a13658519';

const tick = (ms = 10) => jest.advanceTimersByTimeAsync(ms);

describe('multiple devices', () => {
  let fake: FakeBle;
  let devices: VirtualPeripheral[];
  let peripherals: Peripheral[];
  let received: Map<string, number>;

  beforeEach(async () => {
    jest.useFakeTimers();
    fake = installFakeBle();
    devices = Array.from({ length: 6 }, (_, n) =>
      fake.addPeripheral({
        name: `BleKit-Test-${n + 1}`,
        services: [
          {
            uuid: TEST_SERVICE,
            characteristics: [
              { uuid: STATIC_READ, properties: ['read'], value: Uint8Array.of(n) },
              { uuid: STREAM, properties: ['notify'] },
            ],
          },
        ],
      })
    );
    peripherals = devices.map((device) => BleManager.getPeripheral(device.id));
    const connecting = Promise.all(peripherals.map((peripheral) => peripheral.connect()));
    await tick();
    await connecting;
    received = new Map();
    const subscribing = Promise.all(
      peripherals.map((peripheral) =>
        peripheral.subscribe(TEST_SERVICE, STREAM, () =>
          received.set(peripheral.id, (received.get(peripheral.id) ?? 0) + 1)
        )
      )
    );
    await tick();
    await subscribing;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('connects six at once, each with its own state and subscription', async () => {
    expect(peripherals.map((peripheral) => peripheral.state)).toEqual(Array(6).fill('connected'));
    const diagnostics = await BleManager.getDiagnostics();
    expect(diagnostics.sessions).toHaveLength(6);
    expect(diagnostics.sessions.every((session) => session.subscriptions === 1)).toBe(true);
    const reading = Promise.all(peripherals.map((p) => p.read(TEST_SERVICE, STATIC_READ)));
    await tick();
    expect((await reading).map((value) => value[0])).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('a failure on one device stays on that device', async () => {
    fake.injectError({ op: 'read', peripheralId: devices[0].id }, 'GATT_ERROR');
    const reading = Promise.allSettled(peripherals.map((p) => p.read(TEST_SERVICE, STATIC_READ)));
    await tick();
    const results = await reading;
    expect(results.map((result) => result.status)).toEqual([
      'rejected',
      ...Array(5).fill('fulfilled'),
    ]);
  });

  it('one device dropping leaves the others connected and delivering', async () => {
    const states: string[] = [];
    peripherals
      .slice(1)
      .forEach((peripheral) =>
        peripheral.addConnectionStateListener((state) => states.push(state))
      );
    const pending = peripherals[0].read(TEST_SERVICE, STATIC_READ).catch((error) => error.code);
    devices[0].disconnect('linkLoss');
    await tick();
    expect(await pending).toBe('DISCONNECTED');
    expect(peripherals[0].state).toBe('disconnected');

    devices.forEach((device) => device.notify(TEST_SERVICE, STREAM, Uint8Array.of(1)));
    await tick();
    expect(received.get(peripherals[0].id)).toBeUndefined();
    expect(peripherals.slice(1).map((peripheral) => received.get(peripheral.id))).toEqual(
      Array(5).fill(1)
    );
    expect(states).toEqual([]);
    expect(peripherals.slice(1).every((peripheral) => peripheral.state === 'connected')).toBe(true);
  });
});
