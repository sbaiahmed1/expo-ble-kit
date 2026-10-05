import type { GattServer, ServiceDefinition } from 'expo-ble-kit';

import profile from '../../../test-peripherals/profile.json';
import { TestProfile } from './gattNames';
import { profileValue, type ProfileValue } from './profile';

// P4-01: the phone as a GATT server with the test profile's TEST service (a subset; the rest comes
// with notifications and the two-phone suite, P4-02 and P4-05), so the central checks can later run
// against a phone too.

const test = profile.services.find((service) => service.key === 'TEST')!;
const spec = (key: string) =>
  test.characteristics.find((c) => c.key === key)! as (typeof test.characteristics)[number] & {
    value?: ProfileValue;
    descriptors?: { uuid: string; value?: ProfileValue }[];
  };

/** STATIC_READ static; LONG_READ, ECHO_READ and SINK_COUNTER from the handlers; STREAM notifiable. */
export const serverServices: ServiceDefinition[] = [
  {
    uuid: TestProfile.TEST,
    characteristics: [
      {
        uuid: TestProfile.STATIC_READ,
        properties: ['read'],
        permissions: ['readable'],
        value: profileValue(spec('STATIC_READ').value),
      },
      { uuid: TestProfile.LONG_READ, properties: ['read'], permissions: ['readable'] },
      { uuid: TestProfile.ECHO_WRITE, properties: ['write'], permissions: ['writeable'] },
      { uuid: TestProfile.ECHO_READ, properties: ['read'], permissions: ['readable'] },
      { uuid: TestProfile.SINK_NO_RSP, properties: ['writeWithoutResponse'], permissions: ['writeable'] },
      { uuid: TestProfile.SINK_COUNTER, properties: ['read', 'notify'], permissions: ['readable'] },
      {
        uuid: TestProfile.STREAM,
        properties: ['notify'],
        permissions: [],
        descriptors: (spec('STREAM').descriptors ?? []).map((d) => ({
          uuid: d.uuid,
          value: profileValue(d.value) ?? new Uint8Array(0),
        })),
      },
    ],
  },
];

const longRead = profileValue(spec('LONG_READ').value)!;

/**
 * The handlers. LONG_READ shifts by one with every call, so a central that read a value built from
 * two calls would see it: each read must show one consistent shift (the long-read rule, §5.5).
 */
export function serveTestProfile(server: GattServer, onRequest: (line: string) => void) {
  let reads = 0;
  let echo: Uint8Array = new Uint8Array(0);
  let sink = 0;
  const counter = () => {
    const value = new Uint8Array(4);
    new DataView(value.buffer).setUint32(0, sink >>> 0, true);
    return value;
  };
  const name = (uuid: string) => Object.keys(TestProfile).find((key) => TestProfile[key] === uuid) ?? uuid;
  return [
    server.onReadRequest(({ centralId, characteristic, offset }) => {
      onRequest(`read ${name(characteristic)} from ${centralId.slice(-5)} at ${offset}`);
      if (characteristic === TestProfile.LONG_READ) {
        const shift = reads++;
        return longRead.map((byte) => (byte + shift) & 0xff);
      }
      if (characteristic === TestProfile.ECHO_READ) return echo;
      return counter();
    }),
    server.onWriteRequest(({ centralId, characteristic, value }) => {
      onRequest(`write ${name(characteristic)} from ${centralId.slice(-5)}: ${value.length} bytes`);
      if (characteristic === TestProfile.ECHO_WRITE) echo = value;
      else sink += value.length;
    }),
    server.addSubscriptionListener(({ centralId, characteristic, subscribed }) =>
      onRequest(`${subscribed ? 'subscribed to' : 'unsubscribed from'} ${name(characteristic)}: ${centralId.slice(-5)}`)
    ),
  ];
}
