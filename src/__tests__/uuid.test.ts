import { GattCharacteristics, GattServices } from '../constants';
import { BleError } from '../errors';
import { normalizeUUID, uuid16 } from '../uuid';

const HEART_RATE = '0000180d-0000-1000-8000-00805f9b34fb';

function expectInvalid(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BleError);
    expect((error as BleError).code).toBe('INVALID_ARGUMENT');
    return;
  }
  throw new Error('expected INVALID_ARGUMENT');
}

describe('normalizeUUID', () => {
  it.each([
    ['180d', HEART_RATE],
    ['180D', HEART_RATE],
    ['0x180d', HEART_RATE],
    ['0X180D', HEART_RATE],
    ['0000180d', HEART_RATE],
    ['0x0000180D', HEART_RATE],
    ['0000180D-0000-1000-8000-00805F9B34FB', HEART_RATE],
    ['0000180d00001000800000805f9b34fb', HEART_RATE],
    ['12345678', '12345678-0000-1000-8000-00805f9b34fb'],
    ['0C6C1001-B347-4CFA-9827-1C5A13658519', '0c6c1001-b347-4cfa-9827-1c5a13658519'],
  ])('normalizes the string %p', (input, expected) => {
    expect(normalizeUUID(input)).toBe(expected);
  });

  it.each([
    [0x180d, HEART_RATE],
    [0, '00000000-0000-1000-8000-00805f9b34fb'],
    [0xffff, '0000ffff-0000-1000-8000-00805f9b34fb'],
    [0x12345678, '12345678-0000-1000-8000-00805f9b34fb'],
    [0xffffffff, 'ffffffff-0000-1000-8000-00805f9b34fb'],
  ])('normalizes the number %p', (input, expected) => {
    expect(normalizeUUID(input)).toBe(expected);
  });

  it('is idempotent', () => {
    expect(normalizeUUID(normalizeUUID('180d'))).toBe(HEART_RATE);
  });

  it.each([
    '',
    '18d',
    '180d0',
    '0x',
    'xyz1',
    '180g',
    ' 180d',
    '{0000180d-0000-1000-8000-00805f9b34fb}',
    '0000180d-0000-1000-8000-00805f9b34f',
    '0000180d-00001000-8000-00805f9b34fb',
  ])('rejects the string %p', (input) => {
    expectInvalid(() => normalizeUUID(input));
  });

  it.each([-1, 1.5, 0x100000000, NaN, Infinity])('rejects the number %p', (input) => {
    expectInvalid(() => normalizeUUID(input));
  });

  it('rejects non-string, non-number values', () => {
    expectInvalid(() => normalizeUUID(null as unknown as string));
    expectInvalid(() => normalizeUUID({} as unknown as string));
  });
});

describe('uuid16', () => {
  it('builds SIG UUIDs', () => {
    expect(uuid16(0x180d)).toBe(HEART_RATE);
    expect(uuid16(0x2a37)).toBe('00002a37-0000-1000-8000-00805f9b34fb');
  });

  it('rejects values outside 16 bits', () => {
    expectInvalid(() => uuid16(0x10000));
    expectInvalid(() => uuid16(-1));
    expectInvalid(() => uuid16(1.5));
  });
});

describe('constants', () => {
  it('match the Bluetooth SIG assigned numbers', () => {
    expect(GattServices).toEqual({
      HeartRate: HEART_RATE,
      Battery: '0000180f-0000-1000-8000-00805f9b34fb',
      DeviceInformation: '0000180a-0000-1000-8000-00805f9b34fb',
      GenericAccess: '00001800-0000-1000-8000-00805f9b34fb',
    });
    expect(GattCharacteristics).toEqual({
      HeartRateMeasurement: '00002a37-0000-1000-8000-00805f9b34fb',
      BatteryLevel: '00002a19-0000-1000-8000-00805f9b34fb',
      ManufacturerName: '00002a29-0000-1000-8000-00805f9b34fb',
      DeviceName: '00002a00-0000-1000-8000-00805f9b34fb',
    });
  });

  it('are frozen', () => {
    expect(Object.isFrozen(GattServices)).toBe(true);
    expect(Object.isFrozen(GattCharacteristics)).toBe(true);
  });

  it('agree with the test profile', () => {
    // test-peripherals/profile.json exposes the standard Heart Rate service (plan §8.3).
    const profile = require('../../test-peripherals/profile.json');
    const heartRate = profile.services.find((s: { key: string }) => s.key === 'HEART_RATE');
    expect(normalizeUUID(heartRate.uuid)).toBe(GattServices.HeartRate);
    expect(normalizeUUID(heartRate.characteristics[0].uuid)).toBe(
      GattCharacteristics.HeartRateMeasurement
    );
  });
});
