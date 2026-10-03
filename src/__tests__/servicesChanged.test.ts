import { Platform } from 'react-native';

import { BleManager, type Peripheral } from '../index';
import { installFakeBle, type VirtualPeripheral } from '../testing';

// P2-06: service changes and the Android cache refresh, over the fake adapter.

const TEST_SERVICE = '0c6c1000-b347-4cfa-9827-1c5a13658519';
const STATIC_READ = '0c6c1001-b347-4cfa-9827-1c5a13658519';
const STREAM = '0c6c1007-b347-4cfa-9827-1c5a13658519';
const SECONDARY = '0c6c2000-b347-4cfa-9827-1c5a13658519';
const SECONDARY_VALUE = '0c6c2001-b347-4cfa-9827-1c5a13658519';

const testService = {
  uuid: TEST_SERVICE,
  characteristics: [
    { uuid: STATIC_READ, properties: ['read' as const], value: Uint8Array.of(7) },
    { uuid: STREAM, properties: ['notify' as const] },
  ],
};
const secondaryService = {
  uuid: SECONDARY,
  characteristics: [{ uuid: SECONDARY_VALUE, properties: ['read' as const, 'notify' as const] }],
};

const tick = (ms = 50) => jest.advanceTimersByTimeAsync(ms);

describe('services changed', () => {
  let device: VirtualPeripheral;
  let peripheral: Peripheral;
  let changes: string[][];

  beforeEach(async () => {
    jest.useFakeTimers();
    const fake = installFakeBle();
    device = fake.addPeripheral({ name: 'BleKit-Test', services: [testService, secondaryService] });
    peripheral = BleManager.getPeripheral(device.id);
    changes = [];
    peripheral.addServicesChangedListener(() =>
      changes.push(peripheral.services.map((service) => service.uuid))
    );
    const connecting = peripheral.connect();
    await tick();
    await connecting;
  });

  afterEach(() => {
    jest.useRealTimers();
    Platform.OS = 'ios';
  });

  it('discovers again, keeps the subscriptions still possible, and tells the listeners', async () => {
    const values: number[] = [];
    const subscribing = Promise.all([
      peripheral.subscribe(TEST_SERVICE, STREAM, (value) => values.push(value[0])),
      peripheral.subscribe(SECONDARY, SECONDARY_VALUE, () => {}),
    ]);
    await tick();
    const [kept, gone] = await subscribing;

    device.setServices([testService]);
    await tick();
    expect(changes).toEqual([[TEST_SERVICE]]);
    expect(kept.active).toBe(true);
    expect(gone.active).toBe(false);
    device.notify(TEST_SERVICE, STREAM, Uint8Array.of(1));
    await tick();
    expect(values).toEqual([1]);
    const reading = peripheral.read(TEST_SERVICE, STATIC_READ);
    await tick();
    expect((await reading)[0]).toBe(7);

    device.setServices([testService, secondaryService]);
    await tick();
    expect(changes.at(-1)).toEqual([TEST_SERVICE, SECONDARY]);
  });

  it('says nothing while disconnected', async () => {
    const disconnecting = peripheral.disconnect();
    await tick();
    await disconnecting;
    device.setServices([testService]);
    await tick();
    expect(changes).toEqual([]);
  });

  it('refreshGattCache discovers again on Android, and is Android-only', async () => {
    const ios = await peripheral.android.refreshGattCache().catch((error) => error.code);
    expect(ios).toBe('NOT_SUPPORTED');

    Platform.OS = 'android';
    const refreshing = peripheral.android.refreshGattCache();
    await tick();
    expect(await refreshing).toBe(true);
    expect(changes).toEqual([[TEST_SERVICE, SECONDARY]]);
  });

  it('reports a throwing listener without stopping the others', async () => {
    let calls = 0;
    peripheral.addServicesChangedListener(() => {
      throw new Error('app bug');
    });
    peripheral.addServicesChangedListener(() => calls++);
    device.setServices([testService]);
    await tick().catch(() => {});
    await tick().catch(() => {});
    expect(calls).toBe(1);
    expect(() => peripheral.addServicesChangedListener('nope' as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' })
    );
  });
});
