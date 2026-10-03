import { normalizeUUID } from 'expo-ble-kit';

import profile from '../../../test-peripherals/profile.json';

// Readable names for UUIDs: common Bluetooth SIG ones, and every attribute of the test peripheral
// (from test-peripherals/profile.json, the single source of truth for its UUIDs).

const SIG: Record<string, string> = {
  '1800': 'Generic Access',
  '1801': 'Generic Attribute',
  '180a': 'Device Information',
  '180d': 'Heart Rate',
  '180f': 'Battery',
  '2a00': 'Device Name',
  '2a01': 'Appearance',
  '2a05': 'Service Changed',
  '2a19': 'Battery Level',
  '2a24': 'Model Number',
  '2a25': 'Serial Number',
  '2a26': 'Firmware Revision',
  '2a29': 'Manufacturer Name',
  '2a37': 'Heart Rate Measurement',
  '2a38': 'Body Sensor Location',
  '2901': 'User Description',
  '2902': 'Notifications switch (CCCD)',
};

const names = new Map<string, string>(
  Object.entries(SIG).map(([short, name]) => [normalizeUUID(short), name])
);
for (const service of profile.services) {
  if (!names.has(service.uuid)) names.set(service.uuid, `${service.key} service`);
  for (const characteristic of service.characteristics) {
    if (!names.has(characteristic.uuid)) names.set(characteristic.uuid, characteristic.key);
  }
}

/** A readable name, or null for an unknown UUID. */
export function gattName(uuid: string): string | null {
  return names.get(uuid) ?? null;
}

/** `180d` for SIG UUIDs, the full UUID otherwise. */
export function shortUUID(uuid: string): string {
  return uuid.endsWith('-0000-1000-8000-00805f9b34fb') && uuid.startsWith('0000')
    ? uuid.slice(4, 8)
    : uuid;
}

/** The UUIDs of the test peripheral, by profile key. */
export const TestProfile = Object.fromEntries(
  profile.services.flatMap((service) => [
    [service.key, service.uuid],
    ...service.characteristics.map((c) => [c.key, c.uuid]),
  ])
) as Record<string, string>;
