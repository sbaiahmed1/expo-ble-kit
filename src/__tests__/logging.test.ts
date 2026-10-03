import { BleError, BleManager, type LogEntry, type Peripheral } from '../index';
import { installFakeBle, type FakeBle, type VirtualPeripheral } from '../testing';

// P2-07: the log (levels, the handler, one debug line per GATT operation) and getDiagnostics().

const TEST_SERVICE = '0c6c1000-b347-4cfa-9827-1c5a13658519';
const STATIC_READ = '0c6c1001-b347-4cfa-9827-1c5a13658519';
const STREAM = '0c6c1007-b347-4cfa-9827-1c5a13658519';

const tick = (ms = 50) => jest.advanceTimersByTimeAsync(ms);

describe('logging and diagnostics', () => {
  let fake: FakeBle;
  let device: VirtualPeripheral;
  let peripheral: Peripheral;
  let entries: LogEntry[];

  beforeEach(async () => {
    jest.useFakeTimers();
    fake = installFakeBle();
    device = fake.addPeripheral({
      name: 'BleKit-Test',
      services: [
        {
          uuid: TEST_SERVICE,
          characteristics: [
            { uuid: STATIC_READ, properties: ['read'], value: Uint8Array.of(1) },
            { uuid: STREAM, properties: ['notify'] },
          ],
        },
      ],
    });
    peripheral = BleManager.getPeripheral(device.id);
    entries = [];
  });

  afterEach(() => {
    BleManager.setLogHandler(null);
    BleManager.setLogLevel('warn');
    jest.useRealTimers();
  });

  async function run<T>(promise: Promise<T>): Promise<T> {
    promise.catch(() => {});
    await tick();
    return promise;
  }

  it('getDiagnostics() snapshot: state, permissions, sessions and recent errors', async () => {
    await run(peripheral.connect());
    await run(peripheral.subscribe(TEST_SERVICE, STREAM, () => {}));
    await run(peripheral.read(TEST_SERVICE, 'feed')).catch(() => {});
    const diagnostics = await run(BleManager.getDiagnostics());
    const snapshot = {
      ...diagnostics,
      sessions: diagnostics.sessions.map((session) => ({ ...session, id: '<id>' })),
      recentErrors: diagnostics.recentErrors.map((error) => ({
        code: error.code,
        message: error.message.replace(device.id, '<id>'),
        peripheralId: error.peripheralId && '<id>',
        characteristicUUID: error.characteristicUUID,
      })),
    };
    expect(snapshot).toMatchInlineSnapshot(`
      {
        "permissions": {
          "advertise": "granted",
          "backgroundScan": "granted",
          "canAskAgain": true,
          "connect": "granted",
          "scan": "granted",
        },
        "recentErrors": [
          {
            "characteristicUUID": "0000feed-0000-1000-8000-00805f9b34fb",
            "code": "CHARACTERISTIC_NOT_FOUND",
            "message": "Characteristic 0000feed-0000-1000-8000-00805f9b34fb not found in 0c6c1000-b347-4cfa-9827-1c5a13658519",
            "peripheralId": "<id>",
          },
        ],
        "sessions": [
          {
            "id": "<id>",
            "queueDepth": 0,
            "state": "connected",
            "subscriptions": 1,
          },
        ],
        "state": "poweredOn",
      }
    `);
  });

  it('at debug, every GATT operation logs its id, kind, status and duration', async () => {
    BleManager.setLogLevel('debug');
    BleManager.setLogHandler((entry) => entries.push(entry));
    await run(peripheral.connect());
    entries.length = 0;
    await run(peripheral.read(TEST_SERVICE, STATIC_READ));
    const [line] = entries;
    expect(line).toMatchObject({ level: 'debug', peripheralId: device.id });
    expect(line.message).toMatch(/^read 0c6c1001-b347-4cfa-9827-1c5a13658519: ok in \d+ ms$/);
    expect(typeof line.opId).toBe('number');
    expect(line.timestamp).toBeGreaterThan(0);
  });

  it('logs only at or above the level, and stops when the handler is removed', async () => {
    BleManager.setLogHandler((entry) => entries.push(entry));
    await run(peripheral.connect());
    await run(peripheral.read(TEST_SERVICE, STATIC_READ));
    expect(entries).toEqual([]);

    BleManager.setLogLevel('info');
    device.disconnect('linkLoss');
    await tick();
    expect(entries.map((entry) => [entry.level, entry.message])).toEqual([
      ['warn', 'disconnected: DISCONNECTED The link was lost'],
    ]);

    BleManager.setLogHandler(null);
    await run(peripheral.connect());
    expect(entries).toHaveLength(1);
  });

  it('a failed fire-and-forget remove() goes to the log', async () => {
    BleManager.setLogHandler((entry) => entries.push(entry));
    await run(peripheral.connect());
    const subscription = await run(peripheral.subscribe(TEST_SERVICE, STREAM, () => {}));
    fake.injectError({ op: 'unsubscribe' }, 'GATT_ERROR');
    subscription.remove();
    await tick();
    expect(entries.at(-1)).toMatchObject({ level: 'warn', peripheralId: device.id });
    expect(entries.at(-1)?.message).toMatch(
      /^remove\(\) couldn't turn notifications off: GATT_ERROR/
    );
  });

  it('validates the level and the handler', () => {
    expect(() => BleManager.setLogLevel('loud' as never)).toThrow(BleError);
    expect(() => BleManager.setLogHandler('nope' as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' })
    );
  });
});
