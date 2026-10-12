import { Platform } from 'react-native';

import { BleManager, type BackgroundTaskOptions } from '../index';
import { toNativeBackgroundTaskOptions } from '../internal/backgroundTask';
import { getNativeModule } from '../internal/native';
import { installFakeBle } from '../testing';
import type { FakeBleAdapter } from '../testing/FakeBleAdapter';

// registerBackgroundTask: Android's background scans (P3-04) and iOS's restoration events (P3-02),
// delivered to a TaskManager task. The delivery is native (BackgroundScanningTest.kt, the device
// checks); here: the options, the platforms and the preconditions.

const TEST_SERVICE = '0c6c1000-b347-4cfa-9827-1c5a13658519';
const scanTask: BackgroundTaskOptions = {
  events: ['scanResults'],
  scan: { services: ['0c6c1000-b347-4cfa-9827-1c5a13658519'] },
};

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error) => error.code
  );

describe('registerBackgroundTask', () => {
  const platform = Platform.OS;
  afterEach(() => {
    Platform.OS = platform;
  });

  describe('options', () => {
    beforeEach(() => {
      Platform.OS = 'android';
    });

    it('normalizes the scan filters into JSON TaskManager can keep', () => {
      expect(
        toNativeBackgroundTaskOptions({
          events: ['scanResults', 'scanResults'],
          scan: {
            services: ['180D', TEST_SERVICE],
            namePrefix: 'BleKit',
            manufacturerData: [{ companyId: 0x004c, data: Uint8Array.of(2, 21) }],
          },
        })
      ).toEqual({
        events: ['scanResults'],
        scan: {
          services: ['0000180d-0000-1000-8000-00805f9b34fb', TEST_SERVICE],
          namePrefix: 'BleKit',
          manufacturerData: [{ companyId: 76, data: [2, 21] }],
        },
      });
    });

    it.each<[string, unknown, string]>([
      ['no events', { events: [], scan: scanTask.scan }, 'INVALID_ARGUMENT'],
      ['an unknown event', { events: ['beacons'], scan: scanTask.scan }, 'INVALID_ARGUMENT'],
      ['scanResults without scan', { events: ['scanResults'] }, 'INVALID_ARGUMENT'],
      [
        'a scan the controller cannot filter',
        { events: ['scanResults'], scan: { namePrefix: 'BleKit' } },
        'INVALID_ARGUMENT',
      ],
      [
        'an invalid UUID',
        { events: ['scanResults'], scan: { services: ['nope'] } },
        'INVALID_ARGUMENT',
      ],
      ['an event of a later task', { events: ['notification'] }, 'NOT_SUPPORTED'],
      ['not an object', 'scan', 'INVALID_ARGUMENT'],
    ])('rejects %s', async (_, options, expected) => {
      installFakeBle();
      expect(await code(BleManager.registerBackgroundTask('task', options as never))).toBe(
        expected
      );
    });

    it('rejects an empty task name', async () => {
      installFakeBle();
      expect(await code(BleManager.registerBackgroundTask(' ', scanTask))).toBe('INVALID_ARGUMENT');
      expect(await code(BleManager.unregisterBackgroundTask(''))).toBe('INVALID_ARGUMENT');
    });
  });

  it('takes the restoration events on iOS, without a scan', async () => {
    Platform.OS = 'ios';
    expect(
      toNativeBackgroundTaskOptions({
        events: ['restored', 'notification', 'connectionStateChange'],
      })
    ).toEqual({ events: ['restored', 'notification', 'connectionStateChange'] });
    installFakeBle({ state: 'poweredOff', permissions: { backgroundScan: 'denied' } });
    expect(await code(BleManager.registerBackgroundTask('task', scanTask))).toBe('NOT_SUPPORTED');
    expect(
      await code(
        BleManager.registerBackgroundTask('task', { events: ['restored', 'notification'] })
      )
    ).toBe('ok');
    const adapter = getNativeModule() as FakeBleAdapter;
    expect([...adapter.backgroundTasks.keys()]).toEqual(['task']);
    expect(await code(BleManager.unregisterBackgroundTask('task'))).toBe('ok');
    expect(adapter.backgroundTasks.size).toBe(0);
  });

  it('registers on Android with the backgroundScan permission and Bluetooth on', async () => {
    Platform.OS = 'android';
    installFakeBle({ permissions: { backgroundScan: 'denied' } });
    expect(await code(BleManager.registerBackgroundTask('task', scanTask))).toBe(
      'PERMISSION_DENIED'
    );

    const granted = installFakeBle({ state: 'poweredOff' });
    expect(await code(BleManager.registerBackgroundTask('task', scanTask))).toBe(
      'BLUETOOTH_POWERED_OFF'
    );

    granted.setState('poweredOn');
    expect(await code(BleManager.registerBackgroundTask('task', scanTask))).toBe('ok');
    const adapter = getNativeModule() as FakeBleAdapter;
    expect([...adapter.backgroundTasks.keys()]).toEqual(['task']);
    expect(await code(BleManager.unregisterBackgroundTask('task'))).toBe('ok');
    expect(await code(BleManager.unregisterBackgroundTask('unknown'))).toBe('ok');
    expect(adapter.backgroundTasks.size).toBe(0);
  });
});
