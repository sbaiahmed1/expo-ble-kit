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
const IOS = new Set(['backgroundModes']);
const BACKGROUND_MODES = ['peripheral'];
const ANDROID = new Set([
  'neverForLocation',
  'requireBleHardware',
  'foregroundService',
  'backgroundLocation',
  'advertise',
]);
/** Options from plan §4.15 that later versions add. */
const NOT_YET = new Set([
  'ios.restoreIdentifier',
  'ios.accessorySetupKit',
  'android.companionDevice',
]);

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
