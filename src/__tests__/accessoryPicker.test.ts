import { Platform } from 'react-native';

import { BleManager } from '../index';
import { installFakeBle, type FakeBle } from '../testing';

// P5-04: BleManager.ios.showAccessoryPicker over the fake, where a matching advertising virtual
// peripheral is what the person picks.

const TEST = '0c6c1000-b347-4cfa-9827-1c5a13658519';
const tick = (ms = 50) => jest.advanceTimersByTimeAsync(ms);
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error) => error.code
  );

async function settle<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  await tick();
  return promise;
}

describe('accessory picker', () => {
  let fake: FakeBle;

  beforeEach(() => {
    jest.useFakeTimers();
    fake = installFakeBle();
    fake.addPeripheral({
      id: 'acc-1',
      name: 'BleKit-Test',
      services: [{ uuid: TEST, characteristics: [] }],
    });
    Platform.OS = 'ios';
  });

  afterEach(() => {
    jest.useRealTimers();
    Platform.OS = 'ios';
  });

  const item = {
    name: 'BleKit Test',
    productImage: 'https://example.com/accessory.png',
    service: TEST,
  };

  it('resolves the picked accessory as a peripheral, or null', async () => {
    const picked = await settle(BleManager.ios.showAccessoryPicker([item]));
    expect(picked?.id).toBe('acc-1');
    expect(picked).toBe(BleManager.getPeripheral('acc-1'));
    expect(
      await settle(BleManager.ios.showAccessoryPicker([{ ...item, nameSubstring: 'Other' }]))
    ).toBeNull();
    fake.injectError({ op: 'showAccessoryPicker' }, 'MISCONFIGURED');
    expect(await code(settle(BleManager.ios.showAccessoryPicker([item])))).toBe('MISCONFIGURED');
  });

  it('is iOS-only', async () => {
    Platform.OS = 'android';
    expect(await code(BleManager.ios.showAccessoryPicker([item]))).toBe('NOT_SUPPORTED');
  });

  it.each([
    [[], 'at least one item'],
    [[{ ...item, name: '' }], 'name'],
    [[{ ...item, productImage: '' }], 'productImage'],
    [[{ name: 'x', productImage: 'x.png' }], 'a service or a companyId'],
    [[{ ...item, companyId: 0x10000 }], 'companyId'],
    [
      [{ ...item, manufacturerData: { data: Uint8Array.of(1), mask: Uint8Array.of(1) } }],
      'needs a companyId',
    ],
    [
      [{ ...item, serviceData: { data: Uint8Array.of(1), mask: Uint8Array.of(1, 2) } }],
      'same length',
    ],
    [[{ ...item, immediateRange: 'yes' }], 'immediateRange'],
    [[{ ...item, service: 'not a uuid' }], 'UUID'],
  ])('rejects %p', async (items, message) => {
    const error = await BleManager.ios
      .showAccessoryPicker(items as never)
      .catch((thrown) => thrown);
    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.message).toContain(message);
  });
});
