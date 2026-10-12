import { BleManager, type BleError, type L2CAPChannel, type Peripheral } from '../index';
import { installFakeBle, type FakeBle, type VirtualPeripheral } from '../testing';

// P5-03: L2CAP channels and servers over the fake adapter (plan §5.5 L2CAP rules).

const tick = (ms = 50) => jest.advanceTimersByTimeAsync(ms);
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error) => error.code
  );

async function settle<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  await tick();
  return promise;
}

function collect(channel: L2CAPChannel): { bytes: () => Uint8Array } {
  const chunks: Uint8Array[] = [];
  channel.addDataListener((data) => chunks.push(data));
  return {
    bytes: () => {
      const all = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        all.set(chunk, offset);
        offset += chunk.length;
      }
      return all;
    },
  };
}

describe('L2CAP channels', () => {
  let fake: FakeBle;
  let device: VirtualPeripheral;
  let peripheral: Peripheral;

  beforeEach(async () => {
    jest.useFakeTimers();
    fake = installFakeBle();
    device = fake.addPeripheral({ name: 'BleKit-Test', services: [] });
    device.publishL2CAPChannel(0x81);
    peripheral = BleManager.getPeripheral(device.id);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function connect(): Promise<void> {
    await settle(peripheral.connect());
  }

  it('validates the PSM and the options before anything else', async () => {
    for (const psm of [0, 256, 1.5, NaN, '129']) {
      expect(await code(peripheral.openL2CAPChannel(psm as number))).toBe('INVALID_ARGUMENT');
    }
    expect(
      await code(peripheral.openL2CAPChannel(0x81, { android: { secure: 'yes' as never } }))
    ).toBe('INVALID_ARGUMENT');
    expect(await code(peripheral.openL2CAPChannel(0x81, { timeoutMs: -1 }))).toBe(
      'INVALID_ARGUMENT'
    );
    expect(await code(peripheral.openL2CAPChannel(0x81))).toBe('DISCONNECTED');
  });

  it('opens a channel and echoes data, which waits for the first data listener', async () => {
    await connect();
    const channel = await settle(peripheral.openL2CAPChannel(0x81));
    expect(channel).toMatchObject({ psm: 0x81, peerId: device.id, isOpen: true });

    const written = channel.write(new Uint8Array([1, 2, 3]));
    await tick();
    await written;
    // The echo came back before anyone listened: it waits, as flow control holds a real peer back.
    const received = collect(channel);
    await tick();
    expect([...received.bytes()]).toEqual([1, 2, 3]);
  });

  it('carries a large transfer in order, both ways', async () => {
    await connect();
    const channel = await settle(peripheral.openL2CAPChannel(0x81, { android: { secure: false } }));
    const received = collect(channel);
    const data = Uint8Array.from({ length: 64 * 1024 }, (_, i) => (i * 31 + 7) % 251);
    const writes: Promise<void>[] = [];
    for (let offset = 0; offset < data.length; offset += 4096) {
      writes.push(channel.write(data.subarray(offset, offset + 4096)));
    }
    await tick();
    await Promise.all(writes);
    await tick();
    expect(received.bytes()).toEqual(data);
  });

  it('fails for a PSM nobody published, and with an injected error', async () => {
    await connect();
    expect(await code(settle(peripheral.openL2CAPChannel(0x99)))).toBe('L2CAP_FAILED');
    fake.injectError({ op: 'openL2CAPChannel' }, 'L2CAP_FAILED');
    expect(await code(settle(peripheral.openL2CAPChannel(0x81)))).toBe('L2CAP_FAILED');
    expect(await code(settle(peripheral.openL2CAPChannel(0x81)))).toBe('ok');
  });

  it('is cancelled by its signal', async () => {
    await connect();
    const controller = new AbortController();
    const opening = peripheral.openL2CAPChannel(0x81, { signal: controller.signal });
    controller.abort();
    expect(await code(settle(opening))).toBe('OPERATION_CANCELLED');
  });

  it('closes with the connection, and then rejects writes', async () => {
    await connect();
    const channel = await settle(peripheral.openL2CAPChannel(0x81));
    const closes: (BleError | undefined)[] = [];
    channel.addCloseListener((error) => closes.push(error));
    await settle(peripheral.disconnect());
    expect(channel.isOpen).toBe(false);
    expect(closes.map((error) => error?.code)).toEqual(['DISCONNECTED']);
    expect(closes[0]?.peripheralId).toBe(device.id);
    expect(await code(channel.write(new Uint8Array([1])))).toBe('L2CAP_FAILED');

    await connect();
    const again = await settle(peripheral.openL2CAPChannel(0x81));
    const offCloses: (string | undefined)[] = [];
    again.addCloseListener((error) => offCloses.push(error?.code));
    fake.setState('poweredOff');
    expect(offCloses).toEqual(['BLUETOOTH_POWERED_OFF']);
  });

  it('reports a close by either side without an error, once', async () => {
    const peers: { close(): void }[] = [];
    device.publishL2CAPChannel(0x82, (channel) => peers.push(channel));
    await connect();
    const first = await settle(peripheral.openL2CAPChannel(0x82));
    const second = await settle(peripheral.openL2CAPChannel(0x82));
    const closes: string[] = [];
    first.addCloseListener((error) => closes.push(`first ${error?.code ?? 'none'}`));
    second.addCloseListener((error) => closes.push(`second ${error?.code ?? 'none'}`));

    peers[1].close();
    await first.close();
    await first.close();
    await tick();
    expect(closes).toEqual(['second none', 'first none']);
    expect(await code(first.write(new Uint8Array([1])))).toBe('L2CAP_FAILED');
    expect(await code(second.write(new Uint8Array([1])))).toBe('L2CAP_FAILED');
  });

  it('lets an empty write resolve and rejects data that is not bytes', async () => {
    await connect();
    const channel = await settle(peripheral.openL2CAPChannel(0x81));
    await expect(channel.write(new Uint8Array(0))).resolves.toBeUndefined();
    expect(await code(channel.write([1, 2] as never))).toBe('INVALID_ARGUMENT');
  });
});

describe('L2CAP servers', () => {
  let fake: FakeBle;

  beforeEach(() => {
    jest.useFakeTimers();
    fake = installFakeBle();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('accepts channels from centrals and closes them with the server', async () => {
    const server = await settle(BleManager.publishL2CAPChannel({ secure: false }));
    expect(server.psm).toBe(0x80);
    const channels: L2CAPChannel[] = [];
    server.addChannelListener((channel) => {
      channels.push(channel);
      channel.addDataListener((data) => channel.write(data.map((byte) => byte + 1)));
    });

    const central = await settle(fake.openL2CAPChannel(server.psm, { centralId: 'central-a' }));
    expect(channels.map((channel) => channel.peerId)).toEqual(['central-a']);
    const echoes: number[][] = [];
    central.onData((data) => echoes.push([...data]));
    central.write(new Uint8Array([1, 2]));
    await tick();
    expect(echoes).toEqual([[2, 3]]);

    const closes: (string | undefined)[] = [];
    channels[0].addCloseListener((error) => closes.push(error?.code));
    await server.close();
    expect(closes).toEqual([undefined]);
    expect(central.isOpen).toBe(false);
    expect(await code(fake.openL2CAPChannel(server.psm))).toBe('L2CAP_FAILED');
  });

  it('closes a channel that arrives without a listener', async () => {
    const server = await settle(BleManager.publishL2CAPChannel());
    const central = await settle(fake.openL2CAPChannel(server.psm));
    expect(central.isOpen).toBe(false);
  });

  it('runs several servers, and Bluetooth off closes them and their channels', async () => {
    const first = await settle(BleManager.publishL2CAPChannel());
    const second = await settle(BleManager.publishL2CAPChannel());
    expect([first.psm, second.psm]).toEqual([0x80, 0x81]);
    const closes: (string | undefined)[] = [];
    first.addChannelListener((channel) =>
      channel.addCloseListener((error) => closes.push(error?.code))
    );
    await settle(fake.openL2CAPChannel(first.psm));
    fake.setState('poweredOff');
    expect(closes).toEqual(['BLUETOOTH_POWERED_OFF']);
    expect(await code(fake.openL2CAPChannel(second.psm))).toBe('L2CAP_FAILED');
  });

  it('checks Bluetooth, the permission and the options', async () => {
    expect(await code(BleManager.publishL2CAPChannel({ secure: 1 as never }))).toBe(
      'INVALID_ARGUMENT'
    );
    expect(await code(BleManager.publishL2CAPChannel(null as never))).toBe('INVALID_ARGUMENT');
    fake.setState('poweredOff');
    expect(await code(BleManager.publishL2CAPChannel())).toBe('BLUETOOTH_POWERED_OFF');
    fake = installFakeBle({ permissions: { connect: 'denied' } });
    expect(await code(BleManager.publishL2CAPChannel())).toBe('PERMISSION_DENIED');
  });
});
