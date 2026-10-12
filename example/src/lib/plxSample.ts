// P6-01: a react-native-ble-plx app's code. The import below is the only line that changed: it said
// 'react-native-ble-plx'. It scans for the test peripheral, connects, discovers, reads what it can
// (base64, as ble-plx hands values out) and, when the device has Heart Rate, waits for one value.
import { BleError, BleManager, State, fullUUID, type Device } from 'expo-ble-kit/compat/plx';

const TEST_SERVICE = '0c6c1000-b347-4cfa-9827-1c5a13658519';
// Reading SECURE pairs the phones: the sample leaves it out.
const SECURE = '0c6c1009-b347-4cfa-9827-1c5a13658519';
const HEART_RATE = '180D';
const MEASUREMENT = '2A37';

function waitForPoweredOn(manager: BleManager): Promise<void> {
  return new Promise((resolve) => {
    const subscription = manager.onStateChange((state) => {
      if (state === State.PoweredOn) {
        subscription.remove();
        resolve();
      }
    }, true);
  });
}

function scanFirst(manager: BleManager, services: string[], timeoutMs: number): Promise<Device> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      manager.stopDeviceScan();
      reject(new Error('No device found'));
    }, timeoutMs);
    manager.startDeviceScan(services, null, (error, device) => {
      if (error) {
        clearTimeout(timer);
        return reject(error);
      }
      if (device) {
        clearTimeout(timer);
        manager.stopDeviceScan();
        resolve(device);
      }
    });
  });
}

const short = (uuid: string) => uuid.slice(4, 8);

export async function runPlxSample(log: (line: string) => void): Promise<void> {
  const manager = new BleManager();
  await waitForPoweredOn(manager);
  log('Scanning for the TEST service…');
  const device = await scanFirst(manager, [TEST_SERVICE], 10_000);
  log(`Found ${device.name ?? device.id}, ${device.rssi} dBm`);
  const connected = await device.connect();
  try {
    await connected.discoverAllServicesAndCharacteristics();
    const services = await connected.services();
    log(`${services.length} services, MTU ${connected.mtu}`);
    for (const service of services) {
      for (const characteristic of await service.characteristics()) {
        if (!characteristic.isReadable || characteristic.uuid === SECURE) continue;
        try {
          const read = await characteristic.read();
          log(`${short(characteristic.uuid)}: ${read.value}`);
        } catch (error) {
          log(`${short(characteristic.uuid)}: ${(error as BleError).message}`);
        }
      }
    }
    if (services.some((service) => service.uuid === fullUUID(HEART_RATE))) {
      const bpm = await new Promise<number>((resolve, reject) => {
        const subscription = connected.monitorCharacteristicForService(
          HEART_RATE,
          MEASUREMENT,
          (error, characteristic) => {
            if (error) return reject(error);
            subscription.remove();
            resolve(atob(characteristic!.value!).charCodeAt(1));
          }
        );
      });
      log(`Heart rate ${bpm} bpm`);
    }
  } finally {
    await connected.cancelConnection();
  }
}
