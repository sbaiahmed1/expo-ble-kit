import { act, renderHook } from '@testing-library/react-native';

import {
  BleManager,
  useBlePermissions,
  useBleState,
  useCharacteristicValue,
  usePeripheral,
  useScan,
} from '../index';
import { installFakeBle, type FakeBle, type VirtualPeripheral } from '../testing';

// P1-12: the hooks (plan §5.7) against the fake adapter.

const HEART_RATE = '180d';
const MEASUREMENT = '2a37';
const BATTERY = '180f';
const LEVEL = '2a19';

const hrm = {
  name: 'HRM',
  services: [
    { uuid: HEART_RATE, characteristics: [{ uuid: MEASUREMENT, properties: ['notify' as const] }] },
    {
      uuid: BATTERY,
      characteristics: [{ uuid: LEVEL, properties: ['read' as const], value: Uint8Array.of(87) }],
    },
  ],
};

/** Lets the fake answer (later timer ticks) and React render. */
const settle = () => act(() => jest.advanceTimersByTimeAsync(10));

describe('hooks', () => {
  let fake: FakeBle;

  beforeEach(() => {
    jest.useFakeTimers();
    fake = installFakeBle();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('useBleState follows the adapter', async () => {
    const { result } = await renderHook(() => useBleState());
    expect(result.current).toBe('poweredOn');
    await act(() => fake.setState('poweredOff'));
    expect(result.current).toBe('poweredOff');
  });

  it('useBlePermissions reads, then requests', async () => {
    installFakeBle({ permissions: { advertise: 'denied' } });
    const { result } = await renderHook(() => useBlePermissions());
    await settle();
    expect(result.current[0]?.advertise).toBe('denied');
    let granted;
    await act(async () => {
      granted = await result.current[1]({ scan: true });
    });
    expect(granted).toMatchObject({ scan: 'granted' });
    expect(result.current[0]?.scan).toBe('granted');
  });

  describe('useScan', () => {
    it('collects the latest result per device and stops', async () => {
      const device = fake.addPeripheral(hrm);
      fake.addPeripheral({ name: 'Other', services: [] });
      const { result } = await renderHook(() => useScan({ allowDuplicates: true }));
      expect(result.current.isScanning).toBe(true);
      await settle();
      expect(result.current.results.map((r) => r.name).sort()).toEqual(['HRM', 'Other']);

      device.setRssi(-40);
      device.advertise(true);
      await settle();
      expect(result.current.results).toHaveLength(2);
      expect(result.current.results.find((r) => r.id === device.id)?.rssi).toBe(-40);

      await act(() => result.current.stop());
      expect(result.current.isScanning).toBe(false);
      await act(() => result.current.clear());
      expect(result.current.results).toEqual([]);
    });

    it('keeps at most maxResults devices, dropping the least recently seen', async () => {
      const first = fake.addPeripheral({ name: 'A', services: [] });
      await settle();
      const { result } = await renderHook(() => useScan({ allowDuplicates: true, maxResults: 2 }));
      await settle();
      fake.addPeripheral({ name: 'B', services: [] });
      await settle();
      first.advertise(true);
      await settle();
      fake.addPeripheral({ name: 'C', services: [] });
      await settle();
      expect(result.current.results.map((r) => r.name)).toEqual(['A', 'C']);
    });

    it('waits while disabled and filters by the options', async () => {
      fake.addPeripheral(hrm);
      fake.addPeripheral({ name: 'Other', services: [] });
      const { result, rerender } = await renderHook(
        (props: { enabled: boolean }) =>
          useScan({ enabled: props.enabled, services: [HEART_RATE] }),
        {
          initialProps: { enabled: false },
        }
      );
      await settle();
      expect(result.current.isScanning).toBe(false);
      expect(result.current.results).toEqual([]);
      await rerender({ enabled: true });
      await settle();
      expect(result.current.results.map((r) => r.name)).toEqual(['HRM']);
    });

    it('reports errors, and starts again when Bluetooth is back on', async () => {
      fake.addPeripheral(hrm);
      const { result } = await renderHook(() => useScan());
      await settle();
      await act(() => fake.setState('poweredOff'));
      await settle();
      expect(result.current.isScanning).toBe(false);
      expect(result.current.error?.code).toBe('BLUETOOTH_POWERED_OFF');

      await act(() => result.current.clear());
      await act(() => fake.setState('poweredOn'));
      await settle();
      expect(result.current.error).toBeNull();
      expect(result.current.isScanning).toBe(true);
      expect(result.current.results.map((r) => r.name)).toEqual(['HRM']);
    });

    it('reports invalid options without scanning', async () => {
      const { result } = await renderHook(() => useScan({ services: ['nope'] }));
      expect(result.current.error?.code).toBe('INVALID_ARGUMENT');
      expect(result.current.isScanning).toBe(false);
      const { result: max } = await renderHook(() => useScan({ maxResults: 0 }));
      expect(max.current.error?.code).toBe('INVALID_ARGUMENT');
    });
  });

  describe('usePeripheral', () => {
    let device: VirtualPeripheral;

    beforeEach(() => {
      device = fake.addPeripheral(hrm);
    });

    it('follows the connection and keeps the error that ended it', async () => {
      const { result } = await renderHook(() => usePeripheral(device.id));
      expect(result.current.state).toBe('disconnected');
      expect(result.current.peripheral).toBe(BleManager.getPeripheral(device.id));

      await act(() => {
        result.current.peripheral?.connect();
      });
      expect(result.current.state).toBe('connecting');
      await settle();
      expect(result.current.state).toBe('connected');

      await act(() => device.disconnect('linkLoss'));
      expect(result.current.state).toBe('disconnected');
      expect(result.current.error?.code).toBe('DISCONNECTED');

      await act(() => {
        result.current.peripheral?.connect();
      });
      await settle();
      expect(result.current.error).toBeNull();
    });

    it('is empty for null and reports an invalid id', async () => {
      const { result } = await renderHook(() => usePeripheral(null));
      expect(result.current).toEqual({ peripheral: null, state: 'disconnected', error: null });
      const { result: invalid } = await renderHook(() => usePeripheral(''));
      expect(invalid.current.error?.code).toBe('INVALID_ARGUMENT');
    });
  });

  describe('useCharacteristicValue', () => {
    let device: VirtualPeripheral;

    beforeEach(async () => {
      device = fake.addPeripheral(hrm);
      const connecting = BleManager.getPeripheral(device.id).connect();
      await settle();
      await connecting;
    });

    it('follows notifications while connected, and again after a reconnect', async () => {
      const peripheral = BleManager.getPeripheral(device.id);
      const { result } = await renderHook(() =>
        useCharacteristicValue(peripheral, HEART_RATE, MEASUREMENT)
      );
      expect(result.current.value).toBeNull();
      await settle();
      await act(() => device.notify(HEART_RATE, MEASUREMENT, Uint8Array.of(0, 72)));
      expect(result.current.value).toEqual(Uint8Array.of(0, 72));

      await act(() => device.disconnect('linkLoss'));
      expect(result.current.value).toEqual(Uint8Array.of(0, 72));
      await act(async () => {
        const connecting = peripheral.connect();
        await jest.advanceTimersByTimeAsync(10);
        await connecting;
      });
      await settle();
      expect(device.isNotifying(HEART_RATE, MEASUREMENT)).toBe(true);
      await act(() => device.notify(HEART_RATE, MEASUREMENT, Uint8Array.of(0, 75)));
      expect(result.current.value).toEqual(Uint8Array.of(0, 75));
    });

    it('unsubscribes on unmount', async () => {
      const peripheral = BleManager.getPeripheral(device.id);
      const { unmount } = await renderHook(() =>
        useCharacteristicValue(peripheral, HEART_RATE, MEASUREMENT)
      );
      await settle();
      expect(device.isNotifying(HEART_RATE, MEASUREMENT)).toBe(true);
      await unmount();
      await settle();
      expect(device.isNotifying(HEART_RATE, MEASUREMENT)).toBe(false);
    });

    it('batches renders', async () => {
      const peripheral = BleManager.getPeripheral(device.id);
      const { result } = await renderHook(() =>
        useCharacteristicValue(peripheral, HEART_RATE, MEASUREMENT, { batchMs: 100 })
      );
      await settle();
      await act(() => {
        device.notify(HEART_RATE, MEASUREMENT, Uint8Array.of(1));
        device.notify(HEART_RATE, MEASUREMENT, Uint8Array.of(2));
      });
      expect(result.current.value).toBeNull();
      await act(() => jest.advanceTimersByTimeAsync(100));
      expect(result.current.value).toEqual(Uint8Array.of(2));
    });

    it('reads once in read mode, and reports errors', async () => {
      const peripheral = BleManager.getPeripheral(device.id);
      const { result } = await renderHook(() =>
        useCharacteristicValue(peripheral, BATTERY, LEVEL, { mode: 'read' })
      );
      await settle();
      expect(result.current).toEqual({ value: Uint8Array.of(87), error: null });

      const { result: failing } = await renderHook(() =>
        useCharacteristicValue(peripheral, BATTERY, LEVEL)
      );
      await settle();
      expect(failing.current.error?.code).toBe('NOT_SUPPORTED');
      const { result: invalid } = await renderHook(() =>
        useCharacteristicValue(peripheral, 'x', LEVEL)
      );
      expect(invalid.current.error?.code).toBe('INVALID_ARGUMENT');
    });
  });
});
