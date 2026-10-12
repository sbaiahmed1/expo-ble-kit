import { ConfigPlugin, InfoPlist, withInfoPlist } from 'expo/config-plugins';

import { companyId, type ExpoBleKitPluginProps } from './schema';

export const BLUETOOTH_ALWAYS_KEY = 'NSBluetoothAlwaysUsageDescription';
export const BACKGROUND_MODES_KEY = 'UIBackgroundModes';
/** `ios.backgroundModes` values and the `UIBackgroundModes` entries they add (plan §4.14). */
export const BACKGROUND_MODES = {
  central: 'bluetooth-central',
  peripheral: 'bluetooth-peripheral',
} as const;
/** Where `ios.restoreIdentifier` goes; the library reads it at launch (P3-01). */
export const RESTORE_IDENTIFIER_KEY = 'ExpoBleKitRestoreIdentifier';
/** AccessorySetupKit's Info.plist keys (Apple's AccessorySetupKit reference, P5-04). */
export const ACCESSORY_SETUP_KEYS = {
  supports: 'NSAccessorySetupKitSupports',
  services: 'NSAccessorySetupBluetoothServices',
  names: 'NSAccessorySetupBluetoothNames',
  companyIdentifiers: 'NSAccessorySetupBluetoothCompanyIdentifiers',
} as const;
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
  const restoreIdentifier = props.ios?.restoreIdentifier;
  if (restoreIdentifier !== undefined) {
    infoPlist[RESTORE_IDENTIFIER_KEY] = restoreIdentifier;
  }
  const accessories = props.ios?.accessorySetupKit;
  if (accessories) {
    // A 16-bit company id as four hex digits, like a 16-bit UUID (⚠️ VERIFY: Apple names the type, not the form).
    const hex = (value: number | string) =>
      companyId(value)!.toString(16).toUpperCase().padStart(4, '0');
    merge(infoPlist, ACCESSORY_SETUP_KEYS.supports, ['Bluetooth']);
    merge(
      infoPlist,
      ACCESSORY_SETUP_KEYS.services,
      (accessories.services ?? []).map((uuid) => uuid.toUpperCase())
    );
    merge(infoPlist, ACCESSORY_SETUP_KEYS.names, accessories.names ?? []);
    merge(
      infoPlist,
      ACCESSORY_SETUP_KEYS.companyIdentifiers,
      (accessories.companyIdentifiers ?? []).map(hex)
    );
  }
  return infoPlist;
}

/**
 * Adds the values `key` lacks. It never writes an empty list: iOS stops the app when
 * ASAccessorySession starts with a declared list that has no values (P5-04, seen on iOS 27.0.1).
 */
function merge(infoPlist: InfoPlist, key: string, values: string[]) {
  const existing = (infoPlist[key] as string[] | undefined) ?? [];
  const added = values.filter(
    (value, index) => !existing.includes(value) && values.indexOf(value) === index
  );
  if (existing.length + added.length > 0) infoPlist[key] = [...existing, ...added];
}

export const withBleKitIos: ConfigPlugin<ExpoBleKitPluginProps> = (config, props) =>
  withInfoPlist(config, (config) => {
    config.modResults = applyInfoPlist(config.modResults, props);
    return config;
  });
