import type { CharacteristicProperty } from 'expo-ble-kit';
import {
  installFakeBle,
  type FakeBle,
  type VirtualPeripheral,
  type VirtualPeripheralConfig,
} from 'expo-ble-kit/testing';

import profile from '../../../test-peripherals/profile.json';
import { fromUtf8, parseHex } from '../lib/bytes';
import { TestProfile } from '../lib/gattNames';

// Demo mode: the test peripheral (test-peripherals/profile.json) as a virtual device in the fake
// adapter, so the screens, their tests and the Maestro flows run without hardware. The driver
// plays the peripheral's side: heart-rate notifications, ECHO_WRITE → ECHO_READ, SINK_NO_RSP →
// SINK_COUNTER, STREAM frames, and CONTROL SET_STREAM, DISCONNECT_AFTER and RESET_COUNTERS. Real
// hardware runs the Bumble peripheral or the nRF52840 instead.

type ProfileValue = {
  pattern?: { length: number; multiplier: number; offset: number; modulus: number };
  hex?: string;
  utf8?: string;
};

function decode(value: ProfileValue | undefined): Uint8Array | undefined {
  if (!value) return undefined;
  if (value.pattern) {
    const { length, multiplier, offset, modulus } = value.pattern;
    return Uint8Array.from({ length }, (_, i) => (i * multiplier + offset) % modulus);
  }
  if (value.hex !== undefined) return parseHex(value.hex);
  if (value.utf8 !== undefined) return fromUtf8(value.utf8);
  return undefined;
}

/** The services present from the start, as a virtual peripheral named `name`. */
export function testPeripheralConfig(
  name = profile.advertising.localName
): VirtualPeripheralConfig {
  return {
    name,
    mtu: 247,
    services: profile.services
      .filter((service) => service.presence === 'always')
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
      })),
  };
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
  return { ble, device: devices[0], devices, stop: () => stops.forEach((stop) => stop()) };
}
