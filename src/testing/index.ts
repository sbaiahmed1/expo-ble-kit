/**
 * A fake Bluetooth stack for Jest: `installFakeBle()` replaces the native module with virtual
 * peripherals that behave like the real ones (same ordering, timeouts and errors).
 *
 * @module expo-ble-kit/testing
 */
import { BleErrorCode } from '../errors';
import { setNativeModuleOverride } from '../internal/native';
import type { BlePermissions, BleState } from '../types';
import { FakeBleAdapter, type FakeBle } from './FakeBleAdapter';

export type {
  FakeBle,
  FakeOperation,
  VirtualPeripheral,
  VirtualPeripheralConfig,
} from './FakeBleAdapter';
export type { VirtualCentral } from './FakeGattServer';
export type { VirtualL2CAPChannel } from './FakeL2CAP';
export { BleErrorCode };

const ALL_GRANTED: BlePermissions = {
  scan: 'granted',
  connect: 'granted',
  advertise: 'granted',
  backgroundScan: 'granted',
  canAskAgain: true,
};

/**
 * Replaces the native module with a fake for tests (plan §5.8): expo-ble-kit then talks to virtual
 * peripherals. Defaults: Bluetooth on, every permission granted. Calling it again starts over.
 */
export function installFakeBle(
  options: { state?: BleState; permissions?: Partial<BlePermissions> } = {}
): FakeBle {
  const adapter = new FakeBleAdapter({
    state: options.state ?? 'poweredOn',
    permissions: { ...ALL_GRANTED, ...options.permissions },
  });
  setNativeModuleOverride(adapter);
  return {
    addPeripheral: (config) => adapter.addPeripheral(config),
    setState: (state) => adapter.setState(state),
    injectError: (match, code) => adapter.injectError(match, code),
    reset: () => adapter.reset(),
    connectCentral: (options) => adapter.connectCentral(options),
    get advertisement() {
      return adapter.currentAdvertisement();
    },
    openL2CAPChannel: (psm, options) => adapter.openL2CAPChannel(psm, options),
  };
}
