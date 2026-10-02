import { ConfigPlugin, createRunOncePlugin } from 'expo/config-plugins';

import { withBleKitAndroid } from './android';
import { withBleKitIos } from './ios';
import { ExpoBleKitPluginProps, validateProps } from './schema';

export { MIN_ANDROID_SDK } from './android';
export type { ExpoBleKitPluginProps } from './schema';

const withExpoBleKit: ConfigPlugin<ExpoBleKitPluginProps | void> = (config, rawProps) => {
  const props = validateProps(rawProps);
  config = withBleKitIos(config, props);
  config = withBleKitAndroid(config, props);
  return config;
};

export default createRunOncePlugin(withExpoBleKit, 'expo-ble-kit');
