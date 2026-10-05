import type { CharacteristicProperty } from 'expo-ble-kit';
import {
  installFakeBle,
  type FakeBle,
  type VirtualPeripheral,
  type VirtualPeripheralConfig,
} from 'expo-ble-kit/testing';

import profile from '../../../test-peripherals/profile.json';
import { profileValue as decode, type ProfileValue } from '../lib/profile';
import { TestProfile } from '../lib/gattNames';

// Demo mode: the test peripheral (test-peripherals/profile.json) as a virtual device in the fake
// adapter, so the screens, their tests and the Maestro flows run without hardware. The driver
// plays the peripheral's side: heart-rate notifications, ECHO_WRITE → ECHO_READ, SINK_NO_RSP →
// SINK_COUNTER, STREAM frames, and CONTROL SET_STREAM, DISCONNECT_AFTER, TOGGLE_SECONDARY_SERVICE
// and RESET_COUNTERS. Real hardware runs the Bumble peripheral or the nRF52840 instead.

/** The test services: those always present, and SECONDARY while toggled on (CONTROL 0x03). */
function testServices(withSecondary: boolean): VirtualPeripheralConfig['services'] {
  return profile.services
    .filter((service) => service.presence === 'always' || withSecondary)
    .map((service) => ({
      uuid: service.uuid,
      characteristics: service.characteristics.map((characteristic) => {
        const spec = characteristic as typeof characteristic & {
          value?: ProfileValue;
          descriptors?: { uuid: string; value?: ProfileValue }[];
        };
        return {
          uuid: spec.uuid,
          properties: spec.properties as CharacteristicProperty[],
          value: decode(spec.value),
          descriptors: spec.descriptors?.map((d) => ({ uuid: d.uuid, value: decode(d.value) })),
        };
      }),
    }));
}

/** The services present from the start, as a virtual peripheral named `name`. */
export function testPeripheralConfig(
  name = profile.advertising.localName
): VirtualPeripheralConfig {
  return { name, mtu: 247, services: testServices(false) };
}

const HEART_RATE = TestProfile.HEART_RATE;
const MEASUREMENT = TestProfile.HEART_RATE_MEASUREMENT;
const TEST = TestProfile.TEST;
const hrSpec = profile.services
  .flatMap((s) => s.characteristics)
  .find((c) => c.key === 'HEART_RATE_MEASUREMENT') as unknown as {
  intervalMs: number;
  minBpm: number;
  maxBpm: number;
};

/** Plays the peripheral's side of the profile on `device`. Returns a stop function. */
export function driveTestPeripheral(device: VirtualPeripheral): () => void {
  let bpm = hrSpec.minBpm;
  let handled = 0;
  let sinkCount = 0;
  let streamSequence = 0;
  let secondary = false;
  let streamTimer: ReturnType<typeof setInterval> | null = null;
  /** CONTROL SET_STREAM: frames of `frameSize` bytes at `rateHz` (0 stops), see profile.stream. */
  const setStream = (rateHz: number, frameSize: number) => {
    if (streamTimer) clearInterval(streamTimer);
    streamTimer = null;
    if (rateHz === 0) return;
    streamTimer = setInterval(() => {
      if (!device.isNotifying(TEST, TestProfile.STREAM)) return;
      const frame = new Uint8Array(frameSize);
      new DataView(frame.buffer).setUint32(0, streamSequence, true);
      for (let j = 4; j < frameSize; j++) frame[j] = (streamSequence + j - 4) % 256;
      streamSequence++;
      device.notify(TEST, TestProfile.STREAM, frame);
    }, 1000 / rateHz);
  };
  const setSinkCounter = (count: number) => {
    sinkCount = count;
    const value = new Uint8Array(4);
    new DataView(value.buffer).setUint32(0, count >>> 0, true);
    device.setValue(TEST, TestProfile.SINK_COUNTER, value);
  };
  setSinkCounter(0);
  const timers: ReturnType<typeof setTimeout>[] = [];
  const heartRate = setInterval(() => {
    if (device.isNotifying(HEART_RATE, MEASUREMENT)) {
      device.notify(HEART_RATE, MEASUREMENT, Uint8Array.of(0x00, bpm));
      bpm = bpm >= hrSpec.maxBpm ? hrSpec.minBpm : bpm + 1;
    }
  }, hrSpec.intervalMs);
  const writes = setInterval(() => {
    for (; handled < device.writes.length; handled++) {
      const { characteristic, value } = device.writes[handled];
      if (characteristic === TestProfile.ECHO_WRITE) {
        device.setValue(TEST, TestProfile.ECHO_READ, value);
      } else if (characteristic === TestProfile.SINK_NO_RSP) {
        setSinkCounter(sinkCount + value.length);
      } else if (characteristic === TestProfile.CONTROL && value[0] === 0x02 && value.length >= 5) {
        const delayMs = value[1] | (value[2] << 8) | (value[3] << 16) | (value[4] << 24);
        timers.push(setTimeout(() => device.disconnect('peer'), delayMs));
      } else if (characteristic === TestProfile.CONTROL && value[0] === 0x01 && value.length >= 5) {
        setStream(value[1] | (value[2] << 8), value[3] | (value[4] << 8));
      } else if (characteristic === TestProfile.CONTROL && value[0] === 0x03) {
        // The database changes like a firmware update: values come back from the profile.
        secondary = !secondary;
        device.setServices(testServices(secondary));
        setSinkCounter(sinkCount);
      } else if (characteristic === TestProfile.CONTROL && value[0] === 0x04) {
        setSinkCounter(0);
        streamSequence = 0;
      }
    }
  }, 50);
  return () => {
    clearInterval(heartRate);
    clearInterval(writes);
    if (streamTimer) clearInterval(streamTimer);
    timers.forEach(clearTimeout);
  };
}

/** Test peripherals in demo mode: BleKit-Test, then BleKit-Test-2… like extra hardware instances. */
export const DEMO_DEVICES = 5;

let running: FakeBle | null = null;

/** The fake while demo mode runs, so checks can drive it (the soak suite turns its adapter off). */
export const runningDemo = (): FakeBle | null => running;

/**
 * Installs the fake with `count` test peripherals advertising (BleKit-Test first), and starts their
 * drivers. `device` is BleKit-Test.
 */
export function startDemo(count = DEMO_DEVICES): {
  ble: FakeBle;
  device: VirtualPeripheral;
  devices: VirtualPeripheral[];
  stop: () => void;
} {
  const ble = installFakeBle();
  const name = profile.advertising.localName;
  const devices = Array.from({ length: count }, (_, n) =>
    ble.addPeripheral(testPeripheralConfig(n === 0 ? name : `${name}-${n + 1}`))
  );
  const stops = devices.map(driveTestPeripheral);
  running = ble;
  const stop = () => {
    stops.forEach((stopDriver) => stopDriver());
    if (running === ble) running = null;
  };
  return { ble, device: devices[0], devices, stop };
}
