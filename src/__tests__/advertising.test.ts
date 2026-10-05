import { BleManager } from '../index';
import { installFakeBle, type FakeBle } from '../testing';

// P4-03: advertising through the public API, against the fake.

const SERVICE = '0c6c1000-b347-4cfa-9827-1c5a13658519';

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error) => error.code
  );

describe('advertising', () => {
  let fake: FakeBle;

  async function settle<T>(promise: Promise<T>): Promise<T> {
    promise.catch(() => {});
    await jest.advanceTimersByTimeAsync(10);
    return promise;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    fake = installFakeBle();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('advertises the validated data with the defaults, until stopped', async () => {
    const advertisement = await settle(
      BleManager.startAdvertising({
        localName: 'BleKit-Test',
        serviceUUIDs: ['0C6C1000-B347-4CFA-9827-1C5A13658519', '180d', '180D'],
        manufacturerData: { companyId: 0xffff, data: Uint8Array.of(0x42, 0x4b) },
        serviceData: { '180d': Uint8Array.of(1, 2) },
      })
    );
    expect(fake.advertisement).toEqual({
      data: {
        localName: 'BleKit-Test',
        serviceUUIDs: [SERVICE, '0000180d-0000-1000-8000-00805f9b34fb'],
        manufacturerData: { companyId: 0xffff, data: Uint8Array.of(0x42, 0x4b) },
        serviceData: { '0000180d-0000-1000-8000-00805f9b34fb': Uint8Array.of(1, 2) },
        includeTxPower: false,
      },
      options: {
        connectable: true,
        android: { mode: 'lowLatency', txPower: 'medium', extended: false },
      },
    });
    await settle(advertisement.stop());
    expect(fake.advertisement).toBeNull();
    await settle(advertisement.stop()); // a second stop does nothing
  });

  it('keeps the Android options', async () => {
    await settle(
      BleManager.startAdvertising(
        {},
        {
          connectable: false,
          android: { mode: 'lowPower', txPower: 'high', extended: true, timeoutMs: 30_000 },
        }
      )
    );
    expect(fake.advertisement?.options).toEqual({
      connectable: false,
      android: { mode: 'lowPower', txPower: 'high', extended: true, timeoutMs: 30_000 },
    });
  });

  it('runs one advertisement at a time, and an old one never stops a newer one', async () => {
    const first = await settle(BleManager.startAdvertising({ serviceUUIDs: [SERVICE] }));
    expect(await code(settle(BleManager.startAdvertising({})))).toBe('ADVERTISING_FAILED');
    await settle(first.stop());
    const second = await settle(BleManager.startAdvertising({ localName: 'second' }));
    await settle(first.stop());
    expect(fake.advertisement?.data.localName).toBe('second');
    await settle(second.stop());
  });

  it('needs Bluetooth on and the advertise permission, and ends when Bluetooth goes off', async () => {
    const advertisement = await settle(BleManager.startAdvertising({}));
    fake.setState('poweredOff');
    expect(fake.advertisement).toBeNull();
    await settle(advertisement.stop());
    expect(await code(settle(BleManager.startAdvertising({})))).toBe('BLUETOOTH_POWERED_OFF');
    fake.setState('poweredOn');
    fake.injectError({ op: 'startAdvertising' }, 'NOT_SUPPORTED');
    expect(await code(settle(BleManager.startAdvertising({})))).toBe('NOT_SUPPORTED');

    installFakeBle({ permissions: { advertise: 'denied' } });
    expect(await code(settle(BleManager.startAdvertising({})))).toBe('PERMISSION_DENIED');
  });

  it.each<[string, unknown, unknown]>([
    ['no data', undefined, undefined],
    ['an empty localName', { localName: '' }, undefined],
    ['a bad service UUID', { serviceUUIDs: ['nope'] }, undefined],
    ['serviceUUIDs that are no array', { serviceUUIDs: SERVICE }, undefined],
    [
      'a company id over 0xFFFF',
      { manufacturerData: { companyId: 0x10000, data: new Uint8Array(0) } },
      undefined,
    ],
    [
      'manufacturer data that is no Uint8Array',
      { manufacturerData: { companyId: 1, data: [1] } },
      undefined,
    ],
    ['a bad service data key', { serviceData: { nope: Uint8Array.of(1) } }, undefined],
    ['service data that is no Uint8Array', { serviceData: { '180d': 'x' } }, undefined],
    ['includeTxPower that is no boolean', { includeTxPower: 1 }, undefined],
    ['connectable that is no boolean', {}, { connectable: 'yes' }],
    ['an unknown mode', {}, { android: { mode: 'fast' } }],
    ['an unknown txPower', {}, { android: { txPower: 'max' } }],
    ['a timeout under 10 ms', {}, { android: { timeoutMs: 5 } }],
    ['a timeout over 655,350 ms', {}, { android: { timeoutMs: 655_360 } }],
  ])('rejects %s', async (_, data, options) => {
    expect(await code(settle(BleManager.startAdvertising(data as never, options as never)))).toBe(
      'INVALID_ARGUMENT'
    );
    expect(fake.advertisement).toBeNull();
  });
});
