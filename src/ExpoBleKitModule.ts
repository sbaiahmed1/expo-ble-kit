import { NativeModule, requireNativeModule } from 'expo';

import { ExpoBleKitModuleEvents } from './ExpoBleKit.types';
import type { ExpoBleKitModuleSharedObject } from './ExpoBleKitModuleSharedObject';

declare class ExpoBleKitModule extends NativeModule<ExpoBleKitModuleEvents> {
  setValueAsync(value: string): Promise<void>;
  ExpoBleKitModuleSharedObject: typeof ExpoBleKitModuleSharedObject;
}

export default requireNativeModule<ExpoBleKitModule>('ExpoBleKit');
