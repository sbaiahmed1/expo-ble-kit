import { loadNativeModule } from '../ExpoBleKitModule';
import { BleError } from '../errors';
import type { NativeBleKitPort } from './port';

let override: NativeBleKitPort | null = null;
let loaded: NativeBleKitPort | null | undefined;

/**
 * The native module, resolved on first use (plan §4.6): importing expo-ble-kit never touches it, so
 * Jest without a native module and the fake (`expo-ble-kit/testing`) both work.
 */
export function getNativeModule(): NativeBleKitPort {
  if (override) {
    return override;
  }
  if (loaded === undefined) {
    loaded = loadNativeModule();
  }
  if (!loaded) {
    throw new BleError(
      'NOT_SUPPORTED',
      'The expo-ble-kit native module is missing. Rebuild the app (npx expo run:ios or run:android); ' +
        'in tests, install the fake from expo-ble-kit/testing.'
    );
  }
  return loaded;
}

/** Used by `installFakeBle`. Null restores the native module. */
export function setNativeModuleOverride(port: NativeBleKitPort | null): void {
  override = port;
}

/**
 * The raw native module as a lazy stand-in, for the example app until the public API (P1-12)
 * replaces it. Every property access resolves the current module.
 */
export const lazyNativeModule = new Proxy({} as NativeBleKitPort, {
  get(_, property) {
    const module = getNativeModule() as unknown as Record<PropertyKey, unknown>;
    const value = module[property];
    return typeof value === 'function' ? value.bind(module) : value;
  },
});
