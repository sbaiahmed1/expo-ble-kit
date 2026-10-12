/**
 * Config plugin options (plan §4.15): the base declarations, Android's keep-alive foreground
 * service (P3-03), background location for background scans (P3-04), and advertising (P4-03). The
 * other background and onboarding options arrive with P3 and P5.
 */
export type ExpoBleKitPluginProps = {
  /** iOS NSBluetoothAlwaysUsageDescription. `false` skips it (only for apps that set it elsewhere). */
  bluetoothAlwaysPermission?: string | false;
  ios?: {
    /**
     * `UIBackgroundModes` to add. `'peripheral'` (`bluetooth-peripheral`) keeps advertising and the
     * GATT server going in the background. `'central'` arrives with P3.
     */
    backgroundModes?: 'peripheral'[];
    /**
     * iOS 18+ AccessorySetupKit (P5-04): declares the accessories `BleManager.ios.showAccessoryPicker`
     * may look for. Each picker item's service, name substring and company id must be listed here,
     * or iOS crashes the app (the library checks first). Declaring it can change how CoreBluetooth
     * behaves for the whole app: read docs/guides/accessory-setup.md before enabling it.
     */
    accessorySetupKit?: {
      /** Service UUIDs (16- or 128-bit). */
      services?: string[];
      /** Advertised names or parts of them. */
      names?: string[];
      /** Bluetooth SIG company identifiers, as numbers or hex strings. */
      companyIdentifiers?: (number | string)[];
    };
  };
  android?: {
    /** Declare BLUETOOTH_SCAN with `neverForLocation` (Android 12+). Default true. */
    neverForLocation?: boolean;
    /** Mark Bluetooth LE hardware as required in the Play Store listing. Default false. */
    requireBleHardware?: boolean;
    /**
     * Declare the foreground service of `keepAliveInBackground` (type `connectedDevice`) and its
     * permissions. Google Play asks apps to justify each service type they declare. Default false.
     */
    foregroundService?: boolean;
    /**
     * Declare ACCESS_BACKGROUND_LOCATION (up to Android 11), which background scans need on Android
     * 10 and 11. Google Play asks apps that declare it to justify it. Default false.
     */
    backgroundLocation?: boolean;
    /** Declare BLUETOOTH_ADVERTISE (Android 12+), which `startAdvertising` needs. Default false. */
    advertise?: boolean;
  };
};

const TOP_LEVEL = new Set(['bluetoothAlwaysPermission', 'ios', 'android']);
const IOS = new Set(['backgroundModes', 'accessorySetupKit']);
const ACCESSORY_SETUP = new Set(['services', 'names', 'companyIdentifiers']);
const MAX_ACCESSORY_VALUES = 500;
const UUID_PATTERN =
  /^([0-9a-f]{4}|[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const BACKGROUND_MODES = ['peripheral'];
const ANDROID = new Set([
  'neverForLocation',
  'requireBleHardware',
  'foregroundService',
  'backgroundLocation',
  'advertise',
]);
/** Options from plan §4.15 that later versions add. */
const NOT_YET = new Set(['ios.restoreIdentifier', 'android.companionDevice']);

function fail(message: string): never {
  throw new Error(`expo-ble-kit config plugin: ${message}`);
}

function checkKeys(object: Record<string, unknown>, allowed: Set<string>, prefix: string) {
  for (const key of Object.keys(object)) {
    const path = prefix + key;
    if (NOT_YET.has(path)) {
      fail(`the option "${path}" is not available in this version yet.`);
    }
    if (!allowed.has(key)) {
      fail(`unknown option "${path}".`);
    }
  }
}

/** A 0…0xFFFF company id, from a number or a hex string ("0x004C", "004C"). */
export function companyId(value: unknown): number | null {
  if (typeof value === 'number')
    return Number.isInteger(value) && value >= 0 && value <= 0xffff ? value : null;
  if (typeof value !== 'string' || !/^(0x)?[0-9a-f]{1,4}$/i.test(value)) return null;
  return parseInt(value.replace(/^0x/i, ''), 16);
}

function validateAccessorySetup(option: unknown) {
  if (option === undefined) return;
  if (typeof option !== 'object' || option === null || Array.isArray(option)) {
    fail('"ios.accessorySetupKit" must be an object.');
  }
  const props = option as Record<string, unknown>;
  checkKeys(props, ACCESSORY_SETUP, 'ios.accessorySetupKit.');
  for (const key of ACCESSORY_SETUP) {
    const list = props[key];
    if (list !== undefined && !Array.isArray(list))
      fail(`"ios.accessorySetupKit.${key}" must be an array.`);
    // iOS stops the app when a list has more (ASAccessorySession's Info.plist check, iOS 27.0.1).
    if (Array.isArray(list) && list.length > MAX_ACCESSORY_VALUES)
      fail(`"ios.accessorySetupKit.${key}" takes at most ${MAX_ACCESSORY_VALUES} values.`);
  }
  const services = (props.services ?? []) as unknown[];
  const names = (props.names ?? []) as unknown[];
  const companies = (props.companyIdentifiers ?? []) as unknown[];
  if (services.some((uuid) => typeof uuid !== 'string' || !UUID_PATTERN.test(uuid))) {
    fail('"ios.accessorySetupKit.services" takes 16- or 128-bit UUID strings.');
  }
  if (names.some((name) => typeof name !== 'string' || name.length === 0)) {
    fail('"ios.accessorySetupKit.names" takes non-empty strings.');
  }
  if (companies.some((id) => companyId(id) === null)) {
    fail('"ios.accessorySetupKit.companyIdentifiers" takes 0…0xFFFF, as numbers or hex strings.');
  }
  if (services.length === 0 && companies.length === 0) {
    // AccessorySetupKit matches accessories by a service or a company id first.
    fail('"ios.accessorySetupKit" needs at least one service or company identifier.');
  }
}

/** Validates user props. Throws a PluginError for unknown, unsupported or mistyped options. */
export function validateProps(props: unknown): ExpoBleKitPluginProps {
  if (props === undefined || props === null) {
    return {};
  }
  if (typeof props !== 'object' || Array.isArray(props)) {
    fail('options must be an object.');
  }
  const value = props as Record<string, unknown>;
  checkKeys(value, TOP_LEVEL, '');

  const permission = value.bluetoothAlwaysPermission;
  if (permission !== undefined && permission !== false && typeof permission !== 'string') {
    fail('"bluetoothAlwaysPermission" must be a string or false.');
  }

  const ios = value.ios;
  if (ios !== undefined) {
    if (typeof ios !== 'object' || ios === null || Array.isArray(ios)) {
      fail('"ios" must be an object.');
    }
    const iosProps = ios as Record<string, unknown>;
    checkKeys(iosProps, IOS, 'ios.');
    validateAccessorySetup(iosProps.accessorySetupKit);
    const modes = iosProps.backgroundModes;
    if (modes !== undefined) {
      if (!Array.isArray(modes)) fail('"ios.backgroundModes" must be an array.');
      for (const mode of modes) {
        if (mode === 'central') {
          fail('the "ios.backgroundModes" value "central" is not available in this version yet.');
        }
        if (!BACKGROUND_MODES.includes(mode)) {
          fail(`"ios.backgroundModes" takes ${BACKGROUND_MODES.map((m) => `"${m}"`).join(', ')}.`);
        }
      }
    }
  }

  const android = value.android;
  if (android !== undefined) {
    if (typeof android !== 'object' || android === null || Array.isArray(android)) {
      fail('"android" must be an object.');
    }
    const androidProps = android as Record<string, unknown>;
    checkKeys(androidProps, ANDROID, 'android.');
    for (const key of ANDROID) {
      if (androidProps[key] !== undefined && typeof androidProps[key] !== 'boolean') {
        fail(`"android.${key}" must be a boolean.`);
      }
    }
  }
  return value as ExpoBleKitPluginProps;
}
