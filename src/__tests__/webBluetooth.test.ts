import { Platform } from 'react-native';

import { BleManager, type Peripheral } from '../index';
import { setNativeModuleOverride } from '../internal/native';
import type { NativeScanOptions } from '../internal/scanOptions';
import { timerScheduler } from '../internal/scheduler';
import { normalizeUUID } from '../uuid';
import { WebBluetoothAdapter } from '../web/WebBluetoothAdapter';
import type { RequestDeviceOptions, WebBluetooth } from '../web/bluetooth';
import { chooserOptions } from '../web/chooser';

// P6-02: the web adapter over a scripted navigator.bluetooth, through the public API.

const TEST = '0c6c1000-b347-4cfa-9827-1c5a13658519';
const ECHO = '0c6c1001-b347-4cfa-9827-1c5a13658519';
const PULSE = '0c6c1002-b347-4cfa-9827-1c5a13658519';
const DESCRIPTION = normalizeUUID('2901');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error) => error.code
  );

function domError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

const view = (...values: number[]) => new DataView(Uint8Array.from(values).buffer);

class MockCharacteristic extends EventTarget {
  value: DataView | null = null;
  readonly writes: Uint8Array[] = [];
  notifying = false;
  readValue = jest.fn(async () => view(1, 2, 3));
  writeValueWithResponse = jest.fn(async (value: Uint8Array) => {
    this.writes.push(value);
  });
  writeValueWithoutResponse = jest.fn(async (value: Uint8Array) => {
    this.writes.push(value);
  });
  writeValue = jest.fn(async () => {});
  startNotifications = jest.fn(async () => {
    this.notifying = true;
    return this;
  });
  stopNotifications = jest.fn(async () => {
    this.notifying = false;
    return this;
  });
  getDescriptors = jest.fn(async () => [
    { uuid: DESCRIPTION, readValue: async () => view(0x68, 0x69), writeValue: async () => {} },
  ]);

  constructor(
    readonly uuid: string,
    readonly properties: Record<string, boolean>
  ) {
    super();
  }

  notify(...values: number[]) {
    this.value = view(...values);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

function props(...names: string[]): Record<string, boolean> {
  const all = [
    'broadcast',
    'read',
    'writeWithoutResponse',
    'write',
    'notify',
    'indicate',
    'authenticatedSignedWrites',
    'reliableWrite',
    'writableAuxiliaries',
  ];
  return Object.fromEntries(all.map((name) => [name, names.includes(name)]));
}

class MockDevice extends EventTarget {
  readonly echo = new MockCharacteristic(ECHO, props('read', 'write', 'writeWithoutResponse'));
  readonly pulse = new MockCharacteristic(PULSE, props('notify'));
  connected = false;
  connectResult: Promise<void> = Promise.resolve();
  readonly gatt;

  constructor(
    readonly id: string,
    readonly name: string
  ) {
    super();
    const self = this;
    this.gatt = {
      get connected() {
        return self.connected;
      },
      connect: jest.fn(async () => {
        await self.connectResult;
        self.connected = true;
        return self.gatt;
      }),
      disconnect: jest.fn(() => {
        if (!self.connected) return;
        self.connected = false;
        setTimeout(() => self.dispatchEvent(new Event('gattserverdisconnected')), 0);
      }),
      getPrimaryServices: jest.fn(async () => [
        { uuid: TEST, isPrimary: true, getCharacteristics: async () => [self.echo, self.pulse] },
      ]),
    };
    device = this;
  }

  /** The peripheral went away. */
  lose() {
    this.connected = false;
    this.dispatchEvent(new Event('gattserverdisconnected'));
  }
}
let device: MockDevice;

function mockBluetooth(available = true) {
  const target = new EventTarget();
  const requests: RequestDeviceOptions[] = [];
  let next: () => Promise<MockDevice> = async () => new MockDevice('dev-1', 'BleKit-Test');
  const bluetooth = Object.assign(target, {
    getAvailability: jest.fn(async () => available),
    requestDevice: jest.fn(async (options: RequestDeviceOptions) => {
      requests.push(options);
      return next();
    }),
  });
  return {
    bluetooth: bluetooth as unknown as WebBluetooth,
    requests,
    pick(result: () => Promise<MockDevice>) {
      next = result;
    },
  };
}

async function install(available = true) {
  const mock = mockBluetooth(available);
  const adapter = new WebBluetoothAdapter(mock.bluetooth, timerScheduler);
  setNativeModuleOverride(adapter);
  await flush();
  return { ...mock, adapter };
}

async function pickAndConnect(): Promise<Peripheral> {
  const found = await BleManager.scanFor({ services: [TEST], timeoutMs: 1000 });
  const peripheral = BleManager.getPeripheral(found!.id);
  await peripheral.connect();
  return peripheral;
}

describe('Web Bluetooth adapter', () => {
  const platform = Platform.OS;

  beforeEach(() => {
    Platform.OS = 'web';
  });

  afterEach(() => {
    setNativeModuleOverride(null);
    Platform.OS = platform;
  });

  it('reports the browser’s availability as the adapter state', async () => {
    const mock = mockBluetooth(false);
    const adapter = new WebBluetoothAdapter(mock.bluetooth, timerScheduler);
    expect(adapter.getState()).toBe('unknown');
    const states: string[] = [];
    adapter.addListener('stateChange', ({ state }) => states.push(state));
    await flush();
    expect(adapter.getState()).toBe('poweredOff');
    mock.bluetooth.dispatchEvent(Object.assign(new Event('availabilitychanged'), { value: true }));
    expect(states).toEqual(['poweredOff', 'poweredOn']);
    expect(new WebBluetoothAdapter(null, timerScheduler).getState()).toBe('unsupported');
  });

  it('scans through the chooser: the picked device is the one result', async () => {
    const { requests } = await install();
    const found = await BleManager.scanFor({
      services: [TEST],
      timeoutMs: 1000,
      web: { optionalServices: ['180A'] },
    });
    expect(found).toMatchObject({ id: 'dev-1', name: 'BleKit-Test', rssi: 127 });
    expect(requests).toEqual([
      { filters: [{ services: [TEST] }], optionalServices: [normalizeUUID('180A')] },
    ]);
  });

  it('ends the scan when the chooser closes or the browser refuses it', async () => {
    const { pick } = await install();
    pick(async () => {
      throw domError('NotFoundError', 'User cancelled the requestDevice() chooser.');
    });
    expect(await code(BleManager.scanFor({ timeoutMs: 1000 }))).toBe('OPERATION_CANCELLED');
    pick(async () => {
      throw domError(
        'SecurityError',
        'Must be handling a user gesture to show a permission request.'
      );
    });
    expect(await code(BleManager.scanFor({ timeoutMs: 1000 }))).toBe('PERMISSION_DENIED');
  });

  it('connects, discovers, reads, writes and subscribes', async () => {
    await install();
    const peripheral = await pickAndConnect();
    expect(peripheral.state).toBe('connected');
    const [service] = await peripheral.discover();
    expect(service.uuid).toBe(TEST);
    expect(service.characteristics.map((c) => [c.uuid, c.properties])).toEqual([
      [ECHO, ['read', 'writeWithoutResponse', 'write']],
      [PULSE, ['notify']],
    ]);
    expect(service.characteristics[0].descriptors).toEqual([
      { uuid: DESCRIPTION, characteristicUUID: ECHO },
    ]);

    expect([...(await peripheral.read(TEST, ECHO))]).toEqual([1, 2, 3]);
    expect([...(await peripheral.readDescriptor(TEST, ECHO, '2901'))]).toEqual([0x68, 0x69]);
    await peripheral.write(TEST, ECHO, Uint8Array.of(9), { withResponse: true });
    await peripheral.write(TEST, ECHO, Uint8Array.of(8), { withResponse: false });
    expect(device.echo.writeValueWithResponse).toHaveBeenCalledTimes(1);
    expect(device.echo.writeValueWithoutResponse).toHaveBeenCalledTimes(1);
    await peripheral.writeStream(TEST, ECHO, new Uint8Array(50), { withResponse: true });
    expect(device.echo.writes.slice(2).map((chunk) => chunk.length)).toEqual([20, 20, 10]);

    const values: number[][] = [];
    const subscription = await peripheral.subscribe(TEST, PULSE, (value) =>
      values.push([...value])
    );
    expect(device.pulse.notifying).toBe(true);
    device.pulse.notify(60);
    device.pulse.notify(61);
    expect(values).toEqual([[60], [61]]);
    await subscription.unsubscribe();
    expect(device.pulse.notifying).toBe(false);

    await peripheral.disconnect();
    expect(peripheral.state).toBe('disconnected');
    expect(device.gatt.disconnect).toHaveBeenCalled();
  });

  it('runs one GATT operation at a time', async () => {
    await install();
    const peripheral = await pickAndConnect();
    await peripheral.discover();
    let release!: () => void;
    device.echo.readValue.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(view(7))))
    );
    const first = peripheral.read(TEST, ECHO);
    const second = peripheral.read(TEST, ECHO);
    await flush();
    expect(device.echo.readValue).toHaveBeenCalledTimes(1);
    release();
    expect([...(await first)]).toEqual([7]);
    expect([...(await second)]).toEqual([1, 2, 3]);
  });

  it('maps the browser’s GATT errors', async () => {
    await install();
    const peripheral = await pickAndConnect();
    await peripheral.discover();
    device.echo.readValue.mockRejectedValueOnce(
      domError('NotSupportedError', 'GATT operation not permitted.')
    );
    expect(await code(peripheral.read(TEST, ECHO))).toBe('READ_NOT_PERMITTED');
    device.echo.readValue.mockRejectedValueOnce(
      domError('NetworkError', 'GATT Error: Not paired.')
    );
    expect(await code(peripheral.read(TEST, ECHO))).toBe('INSUFFICIENT_AUTHENTICATION');
    expect(await code(peripheral.read(TEST, PULSE))).toBe('READ_NOT_PERMITTED');
  });

  it('ends the connection and its subscriptions when the link is lost', async () => {
    await install();
    const peripheral = await pickAndConnect();
    await peripheral.discover();
    const states: { state: string; error?: string }[] = [];
    peripheral.addConnectionStateListener((state, error) =>
      states.push({ state, ...(error && { error: error.code }) })
    );
    await peripheral.subscribe(TEST, PULSE, () => {});
    device.lose();
    expect(states).toEqual([{ state: 'disconnected', error: 'DISCONNECTED' }]);
    expect(await code(peripheral.read(TEST, ECHO))).toBe('DISCONNECTED');
  });

  it('times out a connect and rejects what browsers can’t do', async () => {
    await install();
    const found = await BleManager.scanFor({ timeoutMs: 1000 });
    const peripheral = BleManager.getPeripheral(found!.id);
    device.connectResult = new Promise(() => {});
    expect(await code(peripheral.connect({ timeoutMs: 20 }))).toBe('CONNECTION_TIMEOUT');
    expect(await code(BleManager.getPeripheral('other').connect())).toBe('PERIPHERAL_NOT_FOUND');
    device.connectResult = Promise.resolve();
    await peripheral.connect();
    expect(await code(peripheral.readRssi())).toBe('NOT_SUPPORTED');
    expect(await code(peripheral.requestMtu(185))).toBe('NOT_SUPPORTED');
    expect(await code(BleManager.openGattServer([{ uuid: TEST, characteristics: [] }]))).toBe(
      'NOT_SUPPORTED'
    );
    expect(await code(BleManager.getSystemConnectedPeripherals([TEST]))).toBe('NOT_SUPPORTED');
    expect(await code(peripheral.connect({ reconnect: { maxAttempts: 2 } }))).toBe('NOT_SUPPORTED');
  });
});

describe('the chooser’s filters', () => {
  const base: NativeScanOptions = {
    services: [],
    allowDuplicates: false,
    reportIntervalMs: 0,
    manufacturerData: [],
    android: { legacy: true, reportDelayMs: 0 },
    ios: { solicitedServices: [] },
    web: { optionalServices: [] },
  };

  it('keeps the scan’s meaning: any service, and the prefix, and any company', () => {
    expect(chooserOptions(base)).toEqual({ acceptAllDevices: true });
    expect(chooserOptions({ ...base, namePrefix: 'Ble' })).toEqual({
      filters: [{ namePrefix: 'Ble' }],
    });
    expect(
      chooserOptions({
        ...base,
        services: [TEST, ECHO],
        namePrefix: 'Ble',
        manufacturerData: [{ companyId: 0xffff }, { companyId: 0x004c, data: Uint8Array.of(2) }],
      }).filters
    ).toEqual([
      { services: [TEST], namePrefix: 'Ble', manufacturerData: [{ companyIdentifier: 0xffff }] },
      {
        services: [TEST],
        namePrefix: 'Ble',
        manufacturerData: [{ companyIdentifier: 0x004c, dataPrefix: Uint8Array.of(2) }],
      },
      { services: [ECHO], namePrefix: 'Ble', manufacturerData: [{ companyIdentifier: 0xffff }] },
      {
        services: [ECHO],
        namePrefix: 'Ble',
        manufacturerData: [{ companyIdentifier: 0x004c, dataPrefix: Uint8Array.of(2) }],
      },
    ]);
  });
});
