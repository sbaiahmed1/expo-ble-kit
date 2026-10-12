import * as plx from '../compat/plx';

// P6-01: the compat layer offers what react-native-ble-plx 3.5.1 exports (its src/index.js and
// src/index.d.ts), name for name, so an app's calls keep resolving after it changes its imports.

const EXPORTED_VALUES = [
  'BleError',
  'BleErrorCode',
  'BleAndroidErrorCode',
  'BleIOSErrorCode',
  'BleATTErrorCode',
  'BleManager',
  'Device',
  'Service',
  'Characteristic',
  'Descriptor',
  'fullUUID',
  'State',
  'LogLevel',
  'ConnectionPriority',
  'ScanCallbackType',
  'ScanMode',
];

const METHODS: Record<string, string[]> = {
  BleManager: [
    'destroy',
    'setLogLevel',
    'logLevel',
    'cancelTransaction',
    'enable',
    'disable',
    'state',
    'onStateChange',
    'startDeviceScan',
    'stopDeviceScan',
    'requestConnectionPriorityForDevice',
    'readRSSIForDevice',
    'requestMTUForDevice',
    'devices',
    'connectedDevices',
    'connectToDevice',
    'cancelDeviceConnection',
    'onDeviceDisconnected',
    'isDeviceConnected',
    'discoverAllServicesAndCharacteristicsForDevice',
    'servicesForDevice',
    'characteristicsForDevice',
    'descriptorsForDevice',
    'readCharacteristicForDevice',
    'writeCharacteristicWithResponseForDevice',
    'writeCharacteristicWithoutResponseForDevice',
    'monitorCharacteristicForDevice',
    'readDescriptorForDevice',
    'writeDescriptorForDevice',
  ],
  Device: [
    'requestConnectionPriority',
    'readRSSI',
    'requestMTU',
    'connect',
    'cancelConnection',
    'isConnected',
    'onDisconnected',
    'discoverAllServicesAndCharacteristics',
    'services',
    'characteristicsForService',
    'descriptorsForService',
    'readCharacteristicForService',
    'writeCharacteristicWithResponseForService',
    'writeCharacteristicWithoutResponseForService',
    'monitorCharacteristicForService',
    'readDescriptorForService',
    'writeDescriptorForService',
  ],
  Service: [
    'characteristics',
    'descriptorsForCharacteristic',
    'readCharacteristic',
    'writeCharacteristicWithResponse',
    'writeCharacteristicWithoutResponse',
    'monitorCharacteristic',
    'readDescriptorForCharacteristic',
    'writeDescriptorForCharacteristic',
  ],
  Characteristic: [
    'descriptors',
    'read',
    'writeWithResponse',
    'writeWithoutResponse',
    'monitor',
    'readDescriptor',
    'writeDescriptor',
  ],
  Descriptor: ['read', 'write'],
};

const ENUMS: Record<string, Record<string, number | string>> = {
  State: {
    Unknown: 'Unknown',
    Resetting: 'Resetting',
    Unsupported: 'Unsupported',
    Unauthorized: 'Unauthorized',
    PoweredOff: 'PoweredOff',
    PoweredOn: 'PoweredOn',
  },
  LogLevel: {
    None: 'None',
    Verbose: 'Verbose',
    Debug: 'Debug',
    Info: 'Info',
    Warning: 'Warning',
    Error: 'Error',
  },
  ConnectionPriority: { Balanced: 0, High: 1, LowPower: 2 },
  ScanMode: { Opportunistic: -1, LowPower: 0, Balanced: 1, LowLatency: 2 },
  ScanCallbackType: { AllMatches: 1, FirstMatch: 2, MatchLost: 4 },
};

describe('the ble-plx 3.5.1 surface', () => {
  it('exports the same values', () => {
    expect(Object.keys(plx).sort()).toEqual([...EXPORTED_VALUES].sort());
  });

  it.each(Object.entries(METHODS))('%s has every method', (name, methods) => {
    const prototype = (plx as unknown as Record<string, { prototype: Record<string, unknown> }>)[
      name
    ].prototype;
    expect(methods.filter((method) => typeof prototype[method] !== 'function')).toEqual([]);
  });

  it.each(Object.entries(ENUMS))('%s has the same members and values', (name, members) => {
    expect((plx as unknown as Record<string, unknown>)[name]).toEqual(members);
  });

  it('keeps the error code numbers', () => {
    expect(plx.BleErrorCode).toMatchObject({
      UnknownError: 0,
      OperationCancelled: 2,
      BluetoothPoweredOff: 102,
      DeviceDisconnected: 201,
      DeviceNotConnected: 205,
      CharacteristicNotFound: 404,
      ScanStartFailed: 600,
      LocationServicesDisabled: 601,
    });
    expect(Object.keys(plx.BleErrorCode)).toHaveLength(39);
    expect(Object.keys(plx.BleATTErrorCode)).toHaveLength(18);
    expect(Object.keys(plx.BleIOSErrorCode)).toHaveLength(13);
    expect(Object.keys(plx.BleAndroidErrorCode)).toHaveLength(16);
  });
});
