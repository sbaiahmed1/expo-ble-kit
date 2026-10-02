import { registerWebModule, NativeModule } from 'expo';

import { ExpoBleKitModuleEvents } from './ExpoBleKit.types';

class ExpoBleKitModule extends NativeModule<ExpoBleKitModuleEvents> {
  async setValueAsync(value: string): Promise<void> {
    this.emit('onChange', { value });
  }
}

export default registerWebModule(ExpoBleKitModule, 'ExpoBleKitModule');
