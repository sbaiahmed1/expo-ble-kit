import { Platform } from 'react-native';

import { BleManager, type Peripheral } from '../index';
import { installFakeBle, type FakeBle } from '../testing';

// P5-01: createBond() and bondState, Android-only, over the fake adapter.

const tick = (ms = 50) => jest.advanceTimersByTimeAsync(ms);
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error) => error.code
  );

describe('bonding', () => {
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

  async function connect() {
    const connecting = peripheral.connect();
    await tick();
    await connecting;
  }

  async function settle<T>(promise: Promise<T>): Promise<T> {
    promise.catch(() => {});
    await tick();
    return promise;
  }

  it('is Android-only: iOS reports none and rejects createBond', async () => {
    await connect();
    expect(peripheral.android.bondState).toBe('none');
    expect(await code(peripheral.android.createBond())).toBe('NOT_SUPPORTED');
  });

  it('bonds a connected peripheral on Android', async () => {
    Platform.OS = 'android';
    expect(await code(settle(peripheral.android.createBond()))).toBe('DISCONNECTED');
    await connect();
    expect(peripheral.android.bondState).toBe('none');
    await settle(peripheral.android.createBond());
    expect(peripheral.android.bondState).toBe('bonded');
  });

  it('reports a refused pairing and a bad timeout', async () => {
    Platform.OS = 'android';
    await connect();
    fake.injectError({ op: 'createBond' }, 'BOND_FAILED');
    expect(await code(settle(peripheral.android.createBond()))).toBe('BOND_FAILED');
    expect(peripheral.android.bondState).toBe('none');
    expect(await code(peripheral.android.createBond({ timeoutMs: -1 }))).toBe('INVALID_ARGUMENT');
  });
});
