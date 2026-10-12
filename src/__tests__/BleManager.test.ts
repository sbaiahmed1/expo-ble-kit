import { BleError, BleManager, type ScanResult } from '../index';
import { getNativeModule } from '../internal/native';
import { installFakeBle, type FakeBle } from '../testing';

// P1-12: the manager (plan §5.2) over the fake adapter.

const HEART_RATE = '0000180d-0000-1000-8000-00805f9b34fb';
const BATTERY = '0000180f-0000-1000-8000-00805f9b34fb';

const heartRate = { name: 'HRM', services: [{ uuid: '180d', characteristics: [] }] };
const battery = { name: 'Battery', services: [{ uuid: '180f', characteristics: [] }] };

/** Runs everything the fake scheduled (its radio answers on later ticks). */
const settle = () => jest.advanceTimersByTimeAsync(10);

async function codeOf(work: Promise<unknown> | (() => unknown)) {
  try {
    await (typeof work === 'function' ? work() : work);
  } catch (error) {
    expect(error).toBeInstanceOf(BleError);
    return (error as BleError).code;
  }
  return 'ok';
}

describe('BleManager', () => {
  let fake: FakeBle;

  beforeEach(() => {
    jest.useFakeTimers();
    fake = installFakeBle();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports the state and its changes', () => {
    const states: string[] = [];
    const listener = BleManager.addStateListener((state) => states.push(state));
    expect(BleManager.state).toBe('poweredOn');
    fake.setState('poweredOff');
    listener.remove();
    fake.setState('poweredOn');
    expect(states).toEqual(['poweredOff']);
  });

  it('reads and requests permissions, checking the request', async () => {
    installFakeBle({ permissions: { scan: 'denied' } });
    expect((await BleManager.getPermissionsAsync()).scan).toBe('denied');
    expect((await BleManager.requestPermissionsAsync({ scan: true })).connect).toBe('granted');
    expect(await codeOf(BleManager.requestPermissionsAsync({ scan: 'yes' } as never))).toBe(
      'INVALID_ARGUMENT'
    );
  });

  describe('scanning', () => {
    it('delivers each session its matches until it stops', async () => {
      fake.addPeripheral(heartRate);
      fake.addPeripheral(battery);
      const all: ScanResult[] = [];
      const hrOnly: ScanResult[] = [];
      const first = BleManager.startScan({}, (results) => all.push(...results));
      const second = BleManager.startScan({ services: ['180d'] }, (r) => hrOnly.push(...r));
      await settle();
      expect(all.map((r) => r.name).sort()).toEqual(['Battery', 'HRM']);
      expect(hrOnly.map((r) => r.name)).toEqual(['HRM']);

      first.stop();
      first.stop();
      expect(first.active).toBe(false);
      expect(second.active).toBe(true);
      second.stop();
    });

    it('ends a session with onError when Bluetooth turns off or it cannot start', async () => {
      const errors: string[] = [];
      const session = BleManager.startScan(
        {},
        () => {},
        (error) => errors.push(error.code)
      );
      fake.setState('poweredOff');
      expect(session.active).toBe(false);
      BleManager.startScan(
        {},
        () => {},
        (error) => errors.push(error.code)
      );
      await settle();
      expect(errors).toEqual(['BLUETOOTH_POWERED_OFF', 'BLUETOOTH_POWERED_OFF']);
    });

    it('throws on invalid options or callbacks', async () => {
      expect(await codeOf(() => BleManager.startScan({ services: ['nope'] }, () => {}))).toBe(
        'INVALID_ARGUMENT'
      );
      expect(await codeOf(() => BleManager.startScan({}, null as never))).toBe('INVALID_ARGUMENT');
    });

    it('scanFor resolves the first match, null on timeout, and rejects on abort', async () => {
      fake.addPeripheral(heartRate);
      fake.addPeripheral(battery);
      const found = BleManager.scanFor({ timeoutMs: 1000, match: (r) => r.name === 'Battery' });
      await settle();
      expect((await found)?.name).toBe('Battery');

      const none = BleManager.scanFor({ services: ['1810'], timeoutMs: 1000 });
      await jest.advanceTimersByTimeAsync(1000);
      expect(await none).toBeNull();

      const controller = new AbortController();
      const aborted = codeOf(
        BleManager.scanFor({ services: ['1810'], timeoutMs: 5000, signal: controller.signal })
      );
      controller.abort();
      expect(await aborted).toBe('OPERATION_CANCELLED');
      expect(await codeOf(BleManager.scanFor({ timeoutMs: 0 }))).toBe('INVALID_ARGUMENT');
      expect(await codeOf(BleManager.scanFor({ timeoutMs: 10, signal: controller.signal }))).toBe(
        'OPERATION_CANCELLED'
      );
    });

    it('scanFor rejects when the scan fails', async () => {
      fake.setState('unauthorized');
      const failed = codeOf(BleManager.scanFor({ timeoutMs: 1000 }));
      await settle();
      expect(await failed).toBe('BLUETOOTH_UNAUTHORIZED');
    });
  });

  describe('peripherals', () => {
    it('getPeripheral returns the same object for the same id, without I/O', () => {
      fake.setState('poweredOff');
      const peripheral = BleManager.getPeripheral('device-1');
      expect(BleManager.getPeripheral('device-1')).toBe(peripheral);
      expect(peripheral.state).toBe('disconnected');
      expect(peripheral.name).toBeNull();
      expect(() => BleManager.getPeripheral('')).toThrow(BleError);
    });

    it('lists known and system-connected peripherals', async () => {
      const hrm = fake.addPeripheral(heartRate);
      fake.addPeripheral(battery);
      const known = await BleManager.getKnownPeripherals([hrm.id, 'unknown']);
      expect(known.map((p) => p.id)).toEqual([hrm.id]);
      expect(known[0]).toBe(BleManager.getPeripheral(hrm.id));

      expect(await BleManager.getSystemConnectedPeripherals([HEART_RATE])).toEqual([]);
      const connecting = known[0].connect();
      await settle();
      await connecting;
      const connected = await BleManager.getSystemConnectedPeripherals(['180d', BATTERY]);
      expect(connected).toEqual([known[0]]);
      expect(await codeOf(BleManager.getSystemConnectedPeripherals(['bad uuid']))).toBe(
        'INVALID_ARGUMENT'
      );
    });

    it('names come from scans', async () => {
      const hrm = fake.addPeripheral(heartRate);
      expect(BleManager.getPeripheral(hrm.id).name).toBeNull();
      const session = BleManager.startScan({}, () => {});
      await settle();
      session.stop();
      expect(BleManager.getPeripheral(hrm.id).name).toBe('HRM');
    });
  });

  it('diagnostics include permissions and recent errors', async () => {
    fake.addPeripheral(heartRate);
    fake.setState('poweredOff');
    await codeOf(BleManager.getKnownPeripherals(['x']));
    const diagnostics = await BleManager.getDiagnostics();
    expect(diagnostics.state).toBe('poweredOff');
    expect(diagnostics.permissions.scan).toBe('granted');
    expect(diagnostics.recentErrors.at(-1)?.code).toBe('BLUETOOTH_POWERED_OFF');
  });

  it('diagnostics pass the iOS restoration journal through', async () => {
    const restoration = {
      enabled: true,
      journal: [{ time: 1, event: 'launched in the background', count: 1 }],
    };
    const native = jest.spyOn(getNativeModule(), 'getDiagnosticsAsync').mockResolvedValue({
      state: 'poweredOn',
      sessions: [],
      ios: { restoration },
    });
    try {
      expect((await BleManager.getDiagnostics()).ios).toEqual({ restoration });
    } finally {
      native.mockRestore();
    }
  });
});
