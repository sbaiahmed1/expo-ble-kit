import { NativeModule, requireNativeModule } from 'expo';

import type { ExpoBleKitModuleEvents } from './ExpoBleKit.types';
import type { NativeScanOptions } from './internal/scanOptions';
import type { BlePermissionRequest, BlePermissions, BleState } from './types';

// The raw native module. Its rejections carry a BleErrorCode `code`; convert them with
// `BleError.fromNative`. The public BleManager (P1-12) wraps this.
declare class ExpoBleKitModule extends NativeModule<ExpoBleKitModuleEvents> {
  getState(): BleState;
  getPermissionsAsync(): Promise<BlePermissions>;
  requestPermissionsAsync(request?: BlePermissionRequest): Promise<BlePermissions>;
  /** Results and the session's end arrive as `scanResults` and `scanError` events. */
  startScan(sessionId: number, options: NativeScanOptions): Promise<void>;
  stopScan(sessionId: number): Promise<void>;
}

export default requireNativeModule<ExpoBleKitModule>('ExpoBleKit');
