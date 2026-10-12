import { Platform } from 'react-native';

import { BleManager, type Peripheral } from '../index';
import { getNativeModule } from '../internal/native';
import { installFakeBle, type FakeBle } from '../testing';
import type { FakeBleAdapter } from '../testing/FakeBleAdapter';

// P3-03: keepAliveInBackground and the foreground service notification. The service itself is
// native (Android `ConnectionService`, tested in KeepAliveTest.kt); here: options and validation.

const TEST_SERVICE = '0c6c1000-b347-4cfa-9827-1c5a13658519';

describe('keepAliveInBackground', () => {
  const platform = Platform.OS;
  let fake: FakeBle;
  let peripheral: Peripheral;

  beforeEach(() => {
    fake = installFakeBle();
    const device = fake.addPeripheral({
      name: 'BleKit-Test',
      services: [{ uuid: TEST_SERVICE, characteristics: [] }],
    });
    peripheral = BleManager.getPeripheral(device.id);
  });

  afterEach(() => {
    Platform.OS = platform;
  });

  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => 'ok',
      (error) => error.code
    );

  it('is accepted on iOS, where the bluetooth-central mode keeps connections (P3-01)', async () => {
    Platform.OS = 'ios';
    expect(await code(peripheral.connect({ keepAliveInBackground: true }))).toBe('ok');
    expect(await code(peripheral.connect({ keepAliveInBackground: 'yes' } as never))).toBe(
      'INVALID_ARGUMENT'
    );
  });

  it('reaches the native connect on Android', async () => {
    Platform.OS = 'android';
    const native = getNativeModule().getPeripheral(peripheral.id);
    const connect = jest.spyOn(native, 'connect');
    expect(await code(peripheral.connect({ keepAliveInBackground: true }))).toBe('ok');
    expect(connect.mock.calls[0][0]).toMatchObject({ keepAliveInBackground: true });
  });

  it('rejects a value that is not a boolean', async () => {
    Platform.OS = 'android';
    expect(await code(peripheral.connect({ keepAliveInBackground: 1 as never }))).toBe(
      'INVALID_ARGUMENT'
    );
  });
});

describe('BleManager.android.setForegroundServiceNotification', () => {
  const platform = Platform.OS;
  let adapter: FakeBleAdapter;

  beforeEach(() => {
    installFakeBle();
    adapter = getNativeModule() as FakeBleAdapter;
  });

  afterEach(() => {
    Platform.OS = platform;
  });

  it('passes the fields that are set on Android', () => {
    Platform.OS = 'android';
    BleManager.android.setForegroundServiceNotification({ title: 'Sensor', text: 'Recording' });
    expect(adapter.foregroundServiceNotification).toEqual({ title: 'Sensor', text: 'Recording' });
  });

  it('does nothing on iOS, but still validates', () => {
    Platform.OS = 'ios';
    BleManager.android.setForegroundServiceNotification({ title: 'Sensor' });
    expect(adapter.foregroundServiceNotification).toEqual({});
    expect(() => BleManager.android.setForegroundServiceNotification({ title: '' })).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' })
    );
  });

  it.each<[string, unknown]>([
    ['not an object', 'Sensor'],
    ['null', null],
    ['an empty title', { title: ' ' }],
    ['a number', { text: 5 }],
    ['an empty icon', { smallIcon: '' }],
  ])('rejects %s', (_, notification) => {
    Platform.OS = 'android';
    expect(() =>
      BleManager.android.setForegroundServiceNotification(notification as never)
    ).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });
});
