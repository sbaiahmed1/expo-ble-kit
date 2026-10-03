/**
 * Config plugin options (plan §4.15): the base declarations and Android's keep-alive foreground
 * service (P3-03). The other background, peripheral-role and onboarding options arrive with P3, P4
 * and P5.
 */
export type ExpoBleKitPluginProps = {
  /** iOS NSBluetoothAlwaysUsageDescription. `false` skips it (only for apps that set it elsewhere). */
  bluetoothAlwaysPermission?: string | false;
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
  };
};

const TOP_LEVEL = new Set(['bluetoothAlwaysPermission', 'android']);
const ANDROID = new Set(['neverForLocation', 'requireBleHardware', 'foregroundService']);
/** Options from plan §4.15 that later versions add. */
const NOT_YET = new Set([
  'ios',
  'android.advertise',
  'android.backgroundScanReceiver',
  'android.backgroundLocation',
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
