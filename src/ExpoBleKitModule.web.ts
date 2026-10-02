import { registerWebModule, NativeModule } from 'expo';

import type { ExpoBleKitModuleEvents } from './ExpoBleKit.types';
import { BleError, BleErrorCode } from './errors';
import type { BlePermissions, BleState } from './types';

// Plan §4.6: until D3 is decided, the web build reports `unsupported` and every call rejects.
class ExpoBleKitModule extends NativeModule<ExpoBleKitModuleEvents> {
  getState(): BleState {
    return 'unsupported';
  }

  async getPermissionsAsync(): Promise<BlePermissions> {
    throw notSupported();
  }

  async requestPermissionsAsync(): Promise<BlePermissions> {
    throw notSupported();
  }

  async startScan(): Promise<void> {
    throw notSupported();
  }

  async stopScan(): Promise<void> {}
}

function notSupported(): BleError {
  return new BleError(BleErrorCode.NOT_SUPPORTED, 'Bluetooth LE is not supported on web.');
}

export default registerWebModule(ExpoBleKitModule, 'ExpoBleKitModule');
