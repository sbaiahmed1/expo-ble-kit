import {
  BleError,
  type AdvertisingData,
  type GattServer,
  type ServiceDefinition,
  type Subscription,
} from 'expo-ble-kit';

import profile from '../../../test-peripherals/profile.json';
import { TestProfile } from './gattNames';
import { profileValue, type ProfileValue } from './profile';

// P4-01, P4-02: the phone as a GATT server with the test profile's TEST service (a subset; the rest
// comes with the two-phone suite, P4-05), so the central checks can run against a phone too. CONTROL
// takes SET_STREAM, RESET_COUNTERS and SEND_INDICATIONS like the Bumble peripheral.

const test = profile.services.find((service) => service.key === 'TEST')!;
const spec = (key: string) =>
  test.characteristics.find((c) => c.key === key)! as (typeof test.characteristics)[number] & {
    value?: ProfileValue;
    descriptors?: { uuid: string; value?: ProfileValue }[];
  };

/** STATIC_READ static; LONG_READ, ECHO_READ and SINK_COUNTER from the handlers; STREAM and INDICATE sent on CONTROL commands. */
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
      {
        uuid: TestProfile.SINK_NO_RSP,
        properties: ['writeWithoutResponse'],
        permissions: ['writeable'],
      },
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
      { uuid: TestProfile.INDICATE, properties: ['indicate'], permissions: [] },
      { uuid: TestProfile.CONTROL, properties: ['write'], permissions: ['writeable'] },
    ],
  },
];

/**
 * The test peripheral's name and service (profile.json advertising), so central checks written for
 * it find the phone. Android advertises the phone's own name instead, with a warning.
 */
export const serverAdvertisement: AdvertisingData = {
  localName: profile.advertising.localName,
  serviceUUIDs: [TestProfile.TEST],
};

const longRead = profileValue(spec('LONG_READ').value)!;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A STREAM frame (profile.json stream.frame): uint32 LE sequence, then (seq + j) % 256. */
export function streamFrame(seq: number, size: number): Uint8Array {
  const frame = Uint8Array.from({ length: size }, (_, i) => (seq + i - 4) & 0xff);
  new DataView(frame.buffer).setUint32(0, seq >>> 0, true);
  return frame;
}

const uint32 = (n: number) => {
  const value = new Uint8Array(4);
  new DataView(value.buffer).setUint32(0, n >>> 0, true);
  return value;
};

// The API has no application ATT errors (profile.json control.errors uses 0x80 and 0x81), so an
// unknown command answers Request Not Supported and bad parameters Invalid Attribute Value Length.
const unknownCommand = () => new BleError('NOT_SUPPORTED', 'Unknown CONTROL command');
const invalidParameters = () =>
  new BleError('INVALID_ATTRIBUTE_LENGTH', 'Invalid CONTROL parameters');

/**
 * The handlers. LONG_READ shifts by one with every call, so a central that read a value built from
 * two calls would see it: each read must show one consistent shift (the long-read rule, §5.5).
 */
export function serveTestProfile(
  server: GattServer,
  onRequest: (line: string) => void
): Subscription[] {
  let reads = 0;
  let echo: Uint8Array = new Uint8Array(0);
  let sink = 0;
  let streamSeq = 0;
  let indicateSeq = 0;
  let stopStream: (() => void) | null = null;
  const streamSubscribers = new Set<string>();
  const name = (uuid: string) =>
    Object.keys(TestProfile).find((key) => TestProfile[key] === uuid) ?? uuid;
  const failed = (what: string) => (error: unknown) =>
    onRequest(`${what}: ${BleError.fromNative(error).code}`);

  /**
   * Notifies frames at `rateHz`, awaiting each one (flow control). Like the Bumble peripheral, the
   * sequence only advances for frames someone receives, so a gap always means a lost frame; a stream
   * that fell more than a second behind starts again from now instead of bursting.
   */
  function startStream(rateHz: number, frameSize: number) {
    let stopped = false;
    stopStream = () => {
      stopped = true;
    };
    const run = async () => {
      let deadline = Date.now();
      while (!stopped) {
        if (streamSubscribers.size > 0) {
          const frame = streamFrame(streamSeq, frameSize);
          // The API doesn't say a central's MTU: a frame too long for one goes out at the minimum
          // (MTU 23), the sequence number intact (profile.json stream.mtuRule).
          await server.notify(TestProfile.STREAM, frame).catch((error: unknown) => {
            if (BleError.fromNative(error).code !== 'INVALID_ATTRIBUTE_LENGTH') throw error;
            return server.notify(TestProfile.STREAM, frame.subarray(0, 20));
          });
          streamSeq = (streamSeq + 1) >>> 0;
        }
        deadline += 1000 / rateHz;
        if (deadline < Date.now() - 1000) deadline = Date.now();
        if (deadline > Date.now()) await sleep(deadline - Date.now());
      }
    };
    run().catch(failed('stream stopped'));
  }

  function control(centralId: string, value: Uint8Array) {
    const params = new DataView(value.buffer, value.byteOffset + 1, Math.max(0, value.length - 1));
    switch (value[0]) {
      case 1: {
        // SET_STREAM(rateHz, frameSize): rateHz 0 stops it.
        if (params.byteLength !== 4) throw invalidParameters();
        const rateHz = params.getUint16(0, true);
        const frameSize = params.getUint16(2, true);
        const { minFrameSize, maxFrameSize } = profile.stream;
        if (
          rateHz !== 0 &&
          (rateHz > 1000 || frameSize < minFrameSize || frameSize > maxFrameSize)
        ) {
          throw invalidParameters();
        }
        stopStream?.();
        stopStream = null;
        if (rateHz) startStream(rateHz, frameSize);
        return;
      }
      case 4:
        // RESET_COUNTERS
        if (params.byteLength !== 0) throw invalidParameters();
        sink = 0;
        streamSeq = 0;
        indicateSeq = 0;
        return;
      case 5: {
        // SEND_INDICATIONS(count) to the central that wrote it, one after another.
        if (params.byteLength !== 2) throw invalidParameters();
        const count = params.getUint16(0, true);
        (async () => {
          for (let i = 0; i < count; i++) {
            await server.notify(TestProfile.INDICATE, uint32(indicateSeq), {
              centrals: [centralId],
            });
            indicateSeq = (indicateSeq + 1) >>> 0;
          }
        })().catch(failed('indications stopped'));
        return;
      }
      default:
        throw unknownCommand();
    }
  }

  return [
    server.onReadRequest(({ centralId, characteristic, offset }) => {
      onRequest(`read ${name(characteristic)} from ${centralId.slice(-5)} at ${offset}`);
      if (characteristic === TestProfile.LONG_READ) {
        const shift = reads++;
        return longRead.map((byte) => (byte + shift) & 0xff);
      }
      if (characteristic === TestProfile.ECHO_READ) return echo;
      return uint32(sink);
    }),
    server.onWriteRequest(({ centralId, characteristic, value }) => {
      onRequest(`write ${name(characteristic)} from ${centralId.slice(-5)}: ${value.length} bytes`);
      if (characteristic === TestProfile.ECHO_WRITE) echo = value;
      else if (characteristic === TestProfile.CONTROL) control(centralId, value);
      else sink += value.length;
    }),
    server.addSubscriptionListener(({ centralId, characteristic, subscribed }) => {
      if (characteristic === TestProfile.STREAM) {
        if (subscribed) streamSubscribers.add(centralId);
        else streamSubscribers.delete(centralId);
      }
      onRequest(
        `${subscribed ? 'subscribed to' : 'unsubscribed from'} ${name(characteristic)}: ${centralId.slice(-5)}`
      );
    }),
    { remove: () => stopStream?.() },
  ];
}
