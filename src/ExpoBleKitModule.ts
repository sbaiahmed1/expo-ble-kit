import { NativeModule, requireNativeModule } from 'expo';

import type { ExpoBleKitModuleEvents } from './ExpoBleKit.types';
import type { BlePermissionRequest, BlePermissions, BleState } from './types';

// The raw native module. Its rejections carry a BleErrorCode `code`; convert them with
// `BleError.fromNative`. The public BleManager (P1-12) wraps this.
declare class ExpoBleKitModule extends NativeModule<ExpoBleKitModuleEvents> {
  getState(): BleState;
  getPermissionsAsync(): Promise<BlePermissions>;
  requestPermissionsAsync(request?: BlePermissionRequest): Promise<BlePermissions>;
}

export default requireNativeModule<ExpoBleKitModule>('ExpoBleKit');
