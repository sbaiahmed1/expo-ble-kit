import { Platform } from 'react-native';
// The sample app below is written against react-native-ble-plx; here that name is the compat layer,
// as it would be after an app changes its imports (P6-01's acceptance).
import { BleErrorCode, BleManager, State, type Device } from 'react-native-ble-plx';

import { fullUUID } from '../compat/plx';
import { fromBase64, toBase64 } from '../compat/plx/base64';
import { installFakeBle, type FakeBle, type VirtualPeripheral } from '../testing';

jest.mock('react-native-ble-plx', () => require('../compat/plx'), { virtual: true });

const HEART_RATE = '180d';
const MEASUREMENT = '2a37';
const BATTERY = '180f';
const LEVEL = '2a19';
const CUSTOM = '0c6c1000-b347-4cfa-9827-1c5a13658519';
const ECHO = '0c6c1003-b347-4cfa-9827-1c5a13658519';
const USER_DESCRIPTION = '2901';

const tick = (ms = 50) => jest.advanceTimersByTimeAsync(ms);

/** Runs `promise` to the end while advancing fake timers. */
async function finish<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  promise.finally(() => (done = true)).catch(() => {});
  while (!done) await tick();
  return promise;
}

const errorOf = (promise: Promise<unknown>) =>
  finish(promise).then(
    () => null,
    (error) => error
  );

// A typical ble-plx app: wait for Bluetooth, scan for a heart-rate monitor, connect, discover,
// read the battery level, then show the heart rate until told to stop.
async function sampleApp(
  onBpm: (bpm: number) => void
): Promise<{ battery: number; stop: () => Promise<void> }> {
  const manager = new BleManager();
  await new Promise<void>((resolve) => {
    const subscription = manager.onStateChange((state) => {
      if (state === State.PoweredOn) {
        subscription.remove();
        resolve();
      }
    }, true);
  });
  const found = await new Promise<Device>((resolve, reject) => {
    manager.startDeviceScan([HEART_RATE], null, (error, device) => {
      if (error) return reject(error);
      if (device?.name === 'HRM') {
        manager.stopDeviceScan();
        resolve(device);
      }
    });
  });
  const device = await found.connect();
  await device.discoverAllServicesAndCharacteristics();
  const level = await device.readCharacteristicForService(BATTERY, LEVEL);
  const subscription = device.monitorCharacteristicForService(
    HEART_RATE,
    MEASUREMENT,
    (error, characteristic) => {
      if (error || !characteristic?.value) return;
      onBpm(atob(characteristic.value).charCodeAt(1));
    }
  );
  return {
    battery: atob(level.value!).charCodeAt(0),
    stop: async () => {
      subscription.remove();
      await device.cancelConnection();
      await manager.destroy();
    },
  };
}

describe('react-native-ble-plx compatibility', () => {
  let fake: FakeBle;
  let hrm: VirtualPeripheral;

  beforeEach(() => {
    jest.useFakeTimers();
    fake = installFakeBle();
    hrm = fake.addPeripheral({
      id: 'hrm-1',
      name: 'HRM',
      services: [
        { uuid: HEART_RATE, characteristics: [{ uuid: MEASUREMENT, properties: ['notify'] }] },
        {
          uuid: BATTERY,
          characteristics: [{ uuid: LEVEL, properties: ['read'], value: Uint8Array.of(87) }],
        },
        {
          uuid: CUSTOM,
          characteristics: [
            {
              uuid: ECHO,
              properties: ['read', 'write', 'writeWithoutResponse', 'indicate'],
              descriptors: [{ uuid: USER_DESCRIPTION, value: new TextEncoder().encode('Echo') }],
            },
          ],
        },
      ],
    });
  });

  afterEach(async () => {
    const manager = BleManager.sharedInstance;
    if (manager) await finish(manager.destroy());
    jest.useRealTimers();
    Platform.OS = 'ios';
  });

  /** A new manager and a connected, discovered device. */
  async function connected(): Promise<{ manager: BleManager; device: Device }> {
    const manager = new BleManager();
    const device = await finish(manager.connectToDevice(hrm.id));
    await finish(device.discoverAllServicesAndCharacteristics());
    return { manager, device };
  }

  it('runs a ble-plx heart-rate app unchanged', async () => {
    const bpm: number[] = [];
    const app = await finish(sampleApp((value) => bpm.push(value)));
    expect(app.battery).toBe(87);
    await tick();
    hrm.notify(HEART_RATE, MEASUREMENT, Uint8Array.of(0, 72));
    hrm.notify(HEART_RATE, MEASUREMENT, Uint8Array.of(0, 74));
    await tick();
    expect(bpm).toEqual([72, 74]);
    await finish(app.stop());
    expect(hrm.isNotifying(HEART_RATE, MEASUREMENT)).toBe(false);
  });

  it('is one shared manager until destroyed', async () => {
    const first = new BleManager();
    expect(new BleManager()).toBe(first);
    await finish(first.destroy());
    expect(new BleManager()).not.toBe(first);
  });

  it('reports the state with ble-plx names', async () => {
    const manager = new BleManager();
    expect(await manager.state()).toBe('PoweredOn');
    const states: string[] = [];
    manager.onStateChange((state) => states.push(state), true);
    await tick();
    fake.setState('poweredOff');
    expect(states).toEqual(['PoweredOn', 'PoweredOff']);
    expect(await manager.state()).toBe(State.PoweredOff);
  });

  it('scans one session at a time and reports scan errors to the listener', async () => {
    const manager = new BleManager();
    const seen: (string | null)[] = [];
    await manager.startDeviceScan(null, { allowDuplicates: true }, (_, device) =>
      seen.push(device?.name ?? null)
    );
    await tick();
    expect(seen).toContain('HRM');
    const scanned: Device[] = [];
    const errors: number[] = [];
    await manager.startDeviceScan([BATTERY], null, (error, device) => {
      if (error) errors.push(error.errorCode);
      if (device) scanned.push(device);
    });
    await tick();
    expect(scanned[0]).toMatchObject({
      id: 'hrm-1',
      name: 'HRM',
      localName: 'HRM',
      rssi: -60,
      manufacturerData: null,
      serviceUUIDs: [fullUUID(HEART_RATE), fullUUID(BATTERY), CUSTOM],
    });
    fake.setState('poweredOff');
    await tick();
    expect(errors).toEqual([BleErrorCode.BluetoothPoweredOff]);
  });

  it('reads, writes and lists attributes in base64 with numeric ids', async () => {
    const { manager, device } = await connected();
    const services = await finish(device.services());
    expect(services.map((service) => service.uuid)).toEqual([
      fullUUID(HEART_RATE),
      fullUUID(BATTERY),
      CUSTOM,
    ]);
    const [echo] = await finish(services[2].characteristics());
    expect(echo).toMatchObject({
      uuid: ECHO,
      serviceUUID: CUSTOM,
      deviceID: 'hrm-1',
      isReadable: true,
      isWritableWithResponse: true,
      isWritableWithoutResponse: true,
      isNotifiable: false,
      isIndicatable: true,
      isNotifying: false,
      value: null,
    });
    expect(echo.id).toBe((await finish(device.characteristicsForService(CUSTOM)))[0].id);

    const written = await finish(echo.writeWithResponse(toBase64(Uint8Array.of(1, 2, 3))));
    expect(written.value).toBe('AQID');
    await finish(
      manager.writeCharacteristicWithoutResponseForDevice('hrm-1', CUSTOM, ECHO, 'BA==')
    );
    expect(hrm.writes.map(({ value, withResponse }) => [[...value], withResponse])).toEqual([
      [[1, 2, 3], true],
      [[4], false],
    ]);
    expect((await finish(echo.read())).value).toBe('BA==');

    const [description] = await finish(echo.descriptors());
    expect(atob((await finish(description.read())).value!)).toBe('Echo');
    await finish(description.write(toBase64(new TextEncoder().encode('Mine'))));
    expect(atob((await finish(echo.readDescriptor(USER_DESCRIPTION))).value!)).toBe('Mine');
  });

  it('turns expo-ble-kit errors into ble-plx errors', async () => {
    const manager = new BleManager();
    const notConnected = await errorOf(
      manager.readCharacteristicForDevice('hrm-1', BATTERY, LEVEL)
    );
    expect(notConnected).toMatchObject({
      name: 'BleError',
      errorCode: BleErrorCode.DeviceNotConnected,
      message: 'Device hrm-1 is not connected',
    });
    const { device } = await connected();
    expect(await errorOf(device.readCharacteristicForService(BATTERY, '2a1a'))).toMatchObject({
      errorCode: BleErrorCode.CharacteristicNotFound,
    });
    fake.injectError({ op: 'read' }, 'READ_NOT_PERMITTED');
    expect(await errorOf(device.readCharacteristicForService(BATTERY, LEVEL))).toMatchObject({
      errorCode: BleErrorCode.CharacteristicReadFailed,
      attErrorCode: 2,
      message: `Characteristic ${LEVEL} read failed for device hrm-1 and service ${BATTERY}`,
    });
    expect(
      await errorOf(device.writeCharacteristicWithResponseForService(CUSTOM, ECHO, 'not base64!'))
    ).toMatchObject({
      errorCode: BleErrorCode.CharacteristicInvalidDataFormat,
    });
    expect(
      await errorOf(device.writeDescriptorForService(CUSTOM, ECHO, '2902', 'AQA='))
    ).toMatchObject({ errorCode: BleErrorCode.DescriptorWriteNotAllowed });
    expect(await errorOf(manager.enable())).toMatchObject({
      errorCode: BleErrorCode.BluetoothStateChangeFailed,
    });
  });

  it("uses the app's error messages", async () => {
    await finish(new BleManager().destroy());
    const manager = new BleManager({
      errorCodesToMessagesMapping: {
        [BleErrorCode.DeviceNotConnected]: 'Pas connecté : {deviceID}',
      },
    });
    expect((await errorOf(manager.readRSSIForDevice('hrm-1'))).message).toBe(
      'Pas connecté : hrm-1'
    );
  });

  it('ends a monitor with OperationCancelled on remove and DeviceDisconnected on a disconnect', async () => {
    const { device } = await connected();
    const events: string[] = [];
    const record = (
      error: { errorCode: number } | null,
      characteristic: { value: string | null; isNotifying: boolean } | null
    ) =>
      events.push(
        error
          ? `error ${error.errorCode}`
          : `${characteristic!.value} ${characteristic!.isNotifying}`
      );
    const first = device.monitorCharacteristicForService(HEART_RATE, MEASUREMENT, record);
    await tick();
    hrm.notify(HEART_RATE, MEASUREMENT, Uint8Array.of(0, 60));
    await tick();
    first.remove();
    await tick();
    expect(events).toEqual(['ADw= true', `error ${BleErrorCode.OperationCancelled}`]);

    events.length = 0;
    device.monitorCharacteristicForService(HEART_RATE, MEASUREMENT, record, 'hr');
    await tick();
    hrm.disconnect('peer');
    await tick();
    expect(events).toEqual([`error ${BleErrorCode.DeviceDisconnected}`]);
  });

  it('cancels by transaction id, and a reused id replaces the earlier call', async () => {
    const { manager, device } = await connected();
    const reading = manager.readCharacteristicForDevice('hrm-1', BATTERY, LEVEL, 'tx');
    await manager.cancelTransaction('tx');
    expect(await errorOf(reading)).toMatchObject({ errorCode: BleErrorCode.OperationCancelled });

    const errors: number[] = [];
    device.monitorCharacteristicForService(
      HEART_RATE,
      MEASUREMENT,
      (error) => error && errors.push(error.errorCode),
      'hr'
    );
    device.monitorCharacteristicForService(
      HEART_RATE,
      MEASUREMENT,
      (error) => error && errors.push(-error.errorCode),
      'hr'
    );
    await tick();
    await manager.cancelTransaction('hr');
    await tick();
    expect(errors).toEqual([BleErrorCode.OperationCancelled, -BleErrorCode.OperationCancelled]);
  });

  it('destroy() rejects the calls in flight, ends monitors and disconnects', async () => {
    const { manager, device } = await connected();
    const monitorErrors: number[] = [];
    device.monitorCharacteristicForService(
      HEART_RATE,
      MEASUREMENT,
      (error) => error && monitorErrors.push(error.errorCode)
    );
    await tick();
    const reading = manager.readCharacteristicForDevice('hrm-1', BATTERY, LEVEL);
    reading.catch(() => {});
    await finish(manager.destroy());
    expect(await errorOf(reading)).toMatchObject({
      errorCode: BleErrorCode.BluetoothManagerDestroyed,
    });
    await tick();
    expect(monitorErrors).toEqual([BleErrorCode.BluetoothManagerDestroyed]);
    expect(await errorOf(manager.state())).toMatchObject({
      errorCode: BleErrorCode.BluetoothManagerDestroyed,
    });
    expect(await errorOf(device.isConnected())).toMatchObject({
      errorCode: BleErrorCode.BluetoothManagerDestroyed,
    });
    expect(await finish(new BleManager().isDeviceConnected('hrm-1'))).toBe(false);
  });

  it("reports disconnects, with an error only when the app didn't ask", async () => {
    const { device } = await connected();
    const events: (number | null)[] = [];
    device.onDisconnected((error) => events.push(error?.errorCode ?? null));
    hrm.disconnect('peer');
    await tick();
    await finish(device.connect());
    await finish(device.cancelConnection());
    expect(events).toEqual([BleErrorCode.DeviceDisconnected, null]);
  });

  it('answers MTU, RSSI, connection priority and device lookups like ble-plx', async () => {
    const { manager, device } = await connected();
    expect((await finish(device.requestMTU(185))).mtu).toBe(23);
    expect((await finish(device.readRSSI())).rssi).toBe(-60);
    // iOS has no connection priority: ble-plx answers without doing anything.
    expect((await finish(device.requestConnectionPriority(1))).id).toBe('hrm-1');
    Platform.OS = 'android';
    expect((await finish(device.requestConnectionPriority(1))).id).toBe('hrm-1');
    expect((await finish(manager.devices(['hrm-1', 'nope']))).map((known) => known.id)).toEqual([
      'hrm-1',
    ]);
    expect((await finish(manager.connectedDevices([BATTERY]))).map((known) => known.id)).toEqual([
      'hrm-1',
    ]);
    expect(await finish(device.isConnected())).toBe(true);
  });

  it('keeps the log level and reports no restored state', async () => {
    await finish(new BleManager().destroy());
    const restored: unknown[] = [];
    const manager = new BleManager({
      restoreStateIdentifier: 'app',
      restoreStateFunction: (state) => restored.push(state),
    });
    await tick();
    expect(restored).toEqual([null]);
    expect(await manager.logLevel()).toBe('Warning');
    expect(await manager.setLogLevel('Debug')).toBe('Debug');
    expect(await manager.logLevel()).toBe('Debug');
  });

  it('converts base64 and UUIDs like ble-plx', () => {
    expect(toBase64(Uint8Array.of(0, 72, 255))).toBe('AEj/');
    expect(toBase64(Uint8Array.of(1))).toBe('AQ==');
    expect([...fromBase64('AQ==')!]).toEqual([1]);
    expect([...fromBase64('AQ')!]).toEqual([1]);
    expect(fromBase64('AQ=?')).toBeNull();
    expect(fromBase64(42)).toBeNull();
    expect(fullUUID('180D')).toBe('0000180d-0000-1000-8000-00805f9b34fb');
    expect(fullUUID('0000180D')).toBe('0000180d-0000-1000-8000-00805f9b34fb');
    expect(fullUUID(CUSTOM.toUpperCase())).toBe(CUSTOM);
  });
});
