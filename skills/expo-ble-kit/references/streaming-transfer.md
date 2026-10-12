# Recipe: streaming and firmware-style transfers

Sending a large payload (a firmware image, a file, a configuration blob) to a device, and receiving a fast stream from one (a 100 Hz sensor, a log dump). The device's protocol decides the details; this shows the library's side.

## Sending: `writeStream`

`writeStream` cuts the data into chunks and writes them one after another in native code, with progress and cancellation. Other operations started meanwhile wait until it ends.

```ts
import { BleError, BleErrorCode, BleManager } from 'expo-ble-kit';

const device = BleManager.getPeripheral(id);
await device.connect();

// Android: a bigger MTU means bigger chunks (iOS picks its own; requestMtu reports it).
const mtu = await device.requestMtu(517).catch(() => device.mtu);

const controller = new AbortController();
try {
  await device.writeStream(DFU_SERVICE, DFU_DATA, image, {
    // Without response (the default): fastest; the library waits while the phone's send buffer is
    // full, so nothing is dropped on the phone. Chunks default to one packet (MTU − 3).
    onProgress: (sent, total) => setProgress(sent / total), // about every 1 %, and at the end
    signal: controller.signal, // controller.abort() stops within the chunk in flight
  });
} catch (e) {
  const error = BleError.fromNative(e);
  // The message says how far it got: "… (stream stopped after 40960 of 131072 bytes)".
  if (error.code !== BleErrorCode.OPERATION_CANCELLED) throw error;
}
```

Choosing the options:

- `withResponse: true` waits for the device to acknowledge every chunk. Slower, but needed by protocols that require acknowledged writes, or devices that drop unacknowledged packets under load. Chunks can then be up to 512 bytes (`chunkSize`), sent as long writes when longer than one packet.
- `chunkSize` smaller than a packet: for devices that expect a fixed record size (for example 20 bytes). Without response it can't exceed MTU − 3; `INVALID_ARGUMENT` says the limit.
- `timeoutMs` applies to each chunk (10 s by default).

### A typical firmware-update flow

Most update protocols use a control characteristic (write + notify) and a data characteristic (write without response):

```ts
const acks: Uint8Array[] = [];
const control = await device.subscribe(DFU_SERVICE, DFU_CONTROL, (value) => acks.push(value));

async function command(bytes: number[], expect: number) {
  acks.length = 0;
  await device.write(DFU_SERVICE, DFU_CONTROL, Uint8Array.from(bytes)); // with response
  // Wait for the device's answer on the control characteristic.
  const deadline = Date.now() + 10_000;
  while (!acks.some((ack) => ack[0] === expect)) {
    if (Date.now() > deadline) throw new Error('The device did not answer');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

await command([0x01, ...uint32le(image.byteLength)], 0x81); // "start, this many bytes"
await device.writeStream(DFU_SERVICE, DFU_DATA, image, { onProgress });
await command([0x02, ...crc32le(image)], 0x82); // "done, check this CRC"
control.remove();
```

Write the device's real opcodes and checks instead of these placeholders. Keep the screen awake and the app in the foreground during an update. On Android, `device.android.requestConnectionPriority('high')` shortens the connection interval for the transfer (more battery), and `device.android.setPreferredPhy(['le2m'], ['le2m'])` doubles the radio rate when both sides support Bluetooth 5.

Plain `write(..., { withResponse: false })` calls also follow the flow control: firing many without awaiting each is safe, they go out in order, and none is dropped on the phone. Nothing confirms the device received them, though.

## Receiving a fast stream: `subscribeBatched`

At 50 Hz and more, one JS call per notification keeps the JS thread busy. `subscribeBatched` collects values natively and calls back at most once per interval:

```ts
const subscription = await device.subscribeBatched(
  SENSOR_SERVICE,
  SAMPLES,
  ({ values, timestamps, dropped }) => {
    // values[i] (a Uint8Array) arrived at timestamps[i] (epoch ms).
    // dropped > 0 only when more than maxItems arrived within one interval.
    samples.push(...values.map(decodeSample));
  },
  { intervalMs: 16, maxItems: 4096 } // ~63 calls a second at most
);
```

For a single value that changes fast in the UI, `useCharacteristicValue(peripheral, service, characteristic, { batchMs: 100 })` re-renders at most ten times a second with the latest value.

## Bulk data both ways: L2CAP channels

When both sides support it (iOS, Android 10+ and the device's firmware), an L2CAP channel is a plain byte stream without GATT's per-packet overhead:

```ts
const psmBytes = await device.read(SERVICE, PSM_CHARACTERISTIC); // how the device tells its channel number
const psm = psmBytes[0] | (psmBytes[1] << 8);
const channel = await device.openL2CAPChannel(psm);
const data = channel.addDataListener((bytes) => received.push(bytes)); // nothing is read before the first listener
channel.addCloseListener((error) => error && console.warn(error.code)); // closed by either side, or lost
await channel.write(payload); // resolves once the phone took the bytes: await each to pace
data.remove();
await channel.close();
```

Chunk boundaries aren't kept: the bytes of one `write` may arrive in several pieces, or with the next. Frame your messages (a length prefix) if the protocol needs them.

## Measuring

`docs/benchmarks.md` in the repository describes the throughput runs. Log at `debug` level (`BleManager.setLogLevel('debug')`) to see each operation's duration; the example app's Throughput tab runs 1 MiB without response, 256 KiB with response, and 10 s of notifications.
