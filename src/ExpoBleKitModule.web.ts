import { registerWebModule, NativeModule } from 'expo';

import type { ExpoBleKitModuleEvents } from './ExpoBleKit.types';
import type { NativePeripheral } from './ExpoBleKitModule';
import { BleError, BleErrorCode } from './errors';
import type { NativeBleKitPort } from './internal/port';
import type { BlePermissions, BleState, Diagnostics } from './types';

class WebPeripheral {
  readonly state = 'disconnected';
  readonly services = [];

  constructor(readonly id: string) {}

  async connect(): Promise<void> {
    throw notSupported();
  }

  async disconnect(): Promise<void> {}

  async discover(): Promise<never> {
    throw notSupported();
  }

  async read(): Promise<never> {
    throw notSupported();
  }

  async write(): Promise<never> {
    throw notSupported();
  }

  async readDescriptor(): Promise<never> {
    throw notSupported();
  }

  async writeDescriptor(): Promise<never> {
    throw notSupported();
  }

  async subscribe(): Promise<never> {
    throw notSupported();
  }

  async unsubscribe(): Promise<void> {}

  addListener() {
    return { remove() {} };
  }
}

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

  getPeripheral(id: string): NativePeripheral {
    return new WebPeripheral(id) as unknown as NativePeripheral;
  }

  async getDiagnosticsAsync(): Promise<Pick<Diagnostics, 'state' | 'sessions'>> {
    return { state: 'unsupported', sessions: [] };
  }
}

function notSupported(): BleError {
  return new BleError(BleErrorCode.NOT_SUPPORTED, 'Bluetooth LE is not supported on web.');
}

const webModule = registerWebModule(ExpoBleKitModule, 'ExpoBleKitModule');

export function loadNativeModule(): NativeBleKitPort {
  return webModule as unknown as NativeBleKitPort;
}
