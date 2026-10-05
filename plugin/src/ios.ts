import { ConfigPlugin, InfoPlist, withInfoPlist } from 'expo/config-plugins';

import type { ExpoBleKitPluginProps } from './schema';

export const BLUETOOTH_ALWAYS_KEY = 'NSBluetoothAlwaysUsageDescription';
export const BACKGROUND_MODES_KEY = 'UIBackgroundModes';
/** `ios.backgroundModes` values and the `UIBackgroundModes` entries they add (plan §4.14). */
export const BACKGROUND_MODES = { peripheral: 'bluetooth-peripheral' } as const;
export const DEFAULT_BLUETOOTH_ALWAYS_PERMISSION =
  'Allow $(PRODUCT_NAME) to use Bluetooth to connect to nearby devices.';

/**
 * Sets NSBluetoothAlwaysUsageDescription (plan §4.13): an explicit string always wins, the default
 * text is only added when the app hasn't set one, and `false` leaves the key alone. Adds the
 * `ios.backgroundModes` entries the app doesn't have yet (plan §4.14).
 */
export function applyInfoPlist(infoPlist: InfoPlist, props: ExpoBleKitPluginProps = {}): InfoPlist {
  const permission = props.bluetoothAlwaysPermission;
  if (typeof permission === 'string') {
    infoPlist[BLUETOOTH_ALWAYS_KEY] = permission;
  } else if (permission !== false) {
    infoPlist[BLUETOOTH_ALWAYS_KEY] ??= DEFAULT_BLUETOOTH_ALWAYS_PERMISSION;
  }
  const modes = (props.ios?.backgroundModes ?? []).map((mode) => BACKGROUND_MODES[mode]);
  if (modes.length > 0) {
    const existing = (infoPlist[BACKGROUND_MODES_KEY] as string[] | undefined) ?? [];
    infoPlist[BACKGROUND_MODES_KEY] = [
      ...existing,
      ...modes.filter((mode) => !existing.includes(mode)),
    ];
  }
  return infoPlist;
}

export const withBleKitIos: ConfigPlugin<ExpoBleKitPluginProps> = (config, props) =>
  withInfoPlist(config, (config) => {
    config.modResults = applyInfoPlist(config.modResults, props);
    return config;
  });
