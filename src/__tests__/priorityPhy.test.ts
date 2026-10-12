import { Platform } from 'react-native';

import { BleManager, type Peripheral } from '../index';
import { installFakeBle, type FakeBle } from '../testing';

// P5-02: connection priority and PHY, Android-only, over the fake adapter.

const tick = (ms = 50) => jest.advanceTimersByTimeAsync(ms);
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error) => error.code
  );

describe('connection priority and PHY', () => {
  let fake: FakeBle;
  let peripheral: Peripheral;

  beforeEach(() => {
    jest.useFakeTimers();
    fake = installFakeBle();
    const device = fake.addPeripheral({ name: 'BleKit-Test', services: [] });
    peripheral = BleManager.getPeripheral(device.id);
  });

  afterEach(() => {
    jest.useRealTimers();
    Platform.OS = 'ios';
  });

  async function settle<T>(promise: Promise<T>): Promise<T> {
    promise.catch(() => {});
    await tick();
    return promise;
  }

  it('is Android-only', async () => {
    expect(await code(peripheral.android.requestConnectionPriority('high'))).toBe('NOT_SUPPORTED');
    expect(await code(peripheral.android.setPreferredPhy(['le2m'], ['le2m']))).toBe(
      'NOT_SUPPORTED'
    );
  });

  it('requests a priority and PHYs on a connected peripheral', async () => {
    Platform.OS = 'android';
    expect(await code(settle(peripheral.android.requestConnectionPriority('high')))).toBe(
      'DISCONNECTED'
    );
    const connecting = peripheral.connect();
    await tick();
    await connecting;
    expect(await code(settle(peripheral.android.requestConnectionPriority('high')))).toBe('ok');
    expect(await settle(peripheral.android.setPreferredPhy(['le2m', 'le1m'], ['le2m']))).toEqual({
      tx: 'le2m',
      rx: 'le2m',
    });
    fake.injectError({ op: 'setPreferredPhy' }, 'NOT_SUPPORTED');
    expect(
      await code(settle(peripheral.android.setPreferredPhy(['leCoded'], ['leCoded'], 's8')))
    ).toBe('NOT_SUPPORTED');
  });

  it.each<[string, () => Promise<unknown>]>([
    ['an unknown priority', () => peripheral.android.requestConnectionPriority('max' as never)],
    ['no tx PHY', () => peripheral.android.setPreferredPhy([], ['le1m'])],
    ['an unknown PHY', () => peripheral.android.setPreferredPhy(['le1m'], ['le3m' as never])],
    [
      'an unknown coding',
      () => peripheral.android.setPreferredPhy(['leCoded'], ['leCoded'], 's4' as never),
    ],
  ])('rejects %s', async (_, call) => {
    Platform.OS = 'android';
    expect(await code(call())).toBe('INVALID_ARGUMENT');
  });
});
