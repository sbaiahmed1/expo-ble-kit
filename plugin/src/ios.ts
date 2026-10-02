import { ConfigPlugin, InfoPlist, withInfoPlist } from 'expo/config-plugins';

import type { ExpoBleKitPluginProps } from './schema';

export const BLUETOOTH_ALWAYS_KEY = 'NSBluetoothAlwaysUsageDescription';
export const DEFAULT_BLUETOOTH_ALWAYS_PERMISSION =
  'Allow $(PRODUCT_NAME) to use Bluetooth to connect to nearby devices.';

/**
 * Sets NSBluetoothAlwaysUsageDescription (plan §4.13). An explicit string always wins; the default
 * text is only added when the app hasn't set one; `false` leaves the key alone.
 */
export function applyInfoPlist(infoPlist: InfoPlist, props: ExpoBleKitPluginProps = {}): InfoPlist {
  const permission = props.bluetoothAlwaysPermission;
  if (permission === false) {
    return infoPlist;
  }
  if (typeof permission === 'string') {
    infoPlist[BLUETOOTH_ALWAYS_KEY] = permission;
  } else {
    infoPlist[BLUETOOTH_ALWAYS_KEY] ??= DEFAULT_BLUETOOTH_ALWAYS_PERMISSION;
  }
  return infoPlist;
}

export const withBleKitIos: ConfigPlugin<ExpoBleKitPluginProps> = (config, props) =>
  withInfoPlist(config, (config) => {
    config.modResults = applyInfoPlist(config.modResults, props);
    return config;
  });
