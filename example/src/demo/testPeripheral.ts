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
// plays the peripheral's side: heart-rate notifications, ECHO_WRITE → ECHO_READ, and CONTROL
// DISCONNECT_AFTER. Real hardware runs the Bumble peripheral or the nRF52840 instead.

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

/** The services present from the start, as a virtual peripheral. */
export function testPeripheralConfig(): VirtualPeripheralConfig {
  return {
    name: profile.advertising.localName,
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
      } else if (characteristic === TestProfile.CONTROL && value[0] === 0x02 && value.length >= 5) {
        const delayMs = value[1] | (value[2] << 8) | (value[3] << 16) | (value[4] << 24);
        timers.push(setTimeout(() => device.disconnect('peer'), delayMs));
      }
    }
  }, 50);
  return () => {
    clearInterval(heartRate);
    clearInterval(writes);
    timers.forEach(clearTimeout);
  };
}

/** Installs the fake with the test peripheral advertising, and starts its driver. */
export function startDemo(): { ble: FakeBle; device: VirtualPeripheral; stop: () => void } {
  const ble = installFakeBle();
  const device = ble.addPeripheral(testPeripheralConfig());
  return { ble, device, stop: driveTestPeripheral(device) };
}
