import { uuid16, type UUID } from './uuid';

/** Common Bluetooth SIG services (assigned numbers), as 128-bit UUIDs. */
export const GattServices: Readonly<
  Record<'HeartRate' | 'Battery' | 'DeviceInformation' | 'GenericAccess', UUID>
> = Object.freeze({
  HeartRate: uuid16(0x180d),
  Battery: uuid16(0x180f),
  DeviceInformation: uuid16(0x180a),
  GenericAccess: uuid16(0x1800),
});

/** Common Bluetooth SIG characteristics (assigned numbers), as 128-bit UUIDs. */
export const GattCharacteristics: Readonly<
  Record<'HeartRateMeasurement' | 'BatteryLevel' | 'ManufacturerName' | 'DeviceName', UUID>
> = Object.freeze({
  HeartRateMeasurement: uuid16(0x2a37),
  BatteryLevel: uuid16(0x2a19),
  ManufacturerName: uuid16(0x2a29),
  DeviceName: uuid16(0x2a00),
});
