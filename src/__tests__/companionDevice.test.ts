import { Platform } from 'react-native';

import { BleManager } from '../index';
import { getNativeModule } from '../internal/native';
import { installFakeBle, type FakeBle } from '../testing';
import type { FakeBleAdapter } from '../testing/FakeBleAdapter';

// P5-05: BleManager.android.associateCompanionDevice over the fake, where a matching advertising
// virtual peripheral is what the person picks, and devicePresence background tasks.

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

describe('companion devices', () => {
  let fake: FakeBle;

  beforeEach(() => {
    jest.useFakeTimers();
    fake = installFakeBle();
    fake.addPeripheral({
      id: 'AA:BB:CC:DD:EE:01',
      name: 'BleKit-Test',
      services: [{ uuid: TEST, characteristics: [] }],
    });
    fake.addPeripheral({
      id: 'AA:BB:CC:DD:EE:02',
      name: 'Pulse',
      services: [{ uuid: '180D', characteristics: [] }],
    });
    Platform.OS = 'android';
  });

  afterEach(() => {
    jest.useRealTimers();
    Platform.OS = 'ios';
  });

  it('resolves the picked device as a peripheral, or null', async () => {
    const picked = await settle(BleManager.android.associateCompanionDevice({ services: [TEST] }));
    expect(picked?.id).toBe('AA:BB:CC:DD:EE:01');
    expect(picked).toBe(BleManager.getPeripheral('AA:BB:CC:DD:EE:01'));
    const byName = await settle(
      BleManager.android.associateCompanionDevice({ services: ['180D', TEST], namePattern: '^Pul' })
    );
    expect(byName?.id).toBe('AA:BB:CC:DD:EE:02');
    expect(
      await settle(BleManager.android.associateCompanionDevice({ namePattern: 'Nothing' }))
    ).toBeNull();
    fake.injectError({ op: 'associateCompanionDevice' }, 'MISCONFIGURED');
    expect(await code(settle(BleManager.android.associateCompanionDevice({})))).toBe(
      'MISCONFIGURED'
    );
  });

  it('checks the filter', async () => {
    for (const filter of [
      null,
      [],
      { services: TEST },
      { services: ['heart'] },
      { namePattern: '' },
      { namePattern: 'BleKit(' },
      { singleDevice: 'yes' },
    ]) {
      expect(await code(BleManager.android.associateCompanionDevice(filter as never))).toBe(
        'INVALID_ARGUMENT'
      );
    }
  });

  it('reports location services', async () => {
    expect(await BleManager.android.isLocationServicesEnabled()).toBe(true);
  });

  it('is Android-only', async () => {
    Platform.OS = 'ios';
    expect(await code(BleManager.android.associateCompanionDevice({ services: [TEST] }))).toBe(
      'NOT_SUPPORTED'
    );
    expect(await code(BleManager.android.isLocationServicesEnabled())).toBe('NOT_SUPPORTED');
  });

  it('registers devicePresence tasks on Android only', async () => {
    await BleManager.registerBackgroundTask('presence', { events: ['devicePresence'] });
    const adapter = getNativeModule() as FakeBleAdapter;
    expect(adapter.backgroundTasks.get('presence')).toEqual({ events: ['devicePresence'] });
    await BleManager.unregisterBackgroundTask('presence');
    Platform.OS = 'ios';
    expect(
      await code(BleManager.registerBackgroundTask('presence', { events: ['devicePresence'] }))
    ).toBe('NOT_SUPPORTED');
  });
});
