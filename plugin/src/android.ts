import { AndroidConfig, ConfigPlugin, withFinalizedMod } from 'expo/config-plugins';
import { promises as fs } from 'fs';
import { join } from 'path';

import type { ExpoBleKitPluginProps } from './schema';

/** ADR-002: the Android core relies on API 26+ calls. */
export const MIN_ANDROID_SDK = 26;
const MIN_SDK_PROPERTY = 'android.minSdkVersion';

export type PermissionDeclaration = {
  name: string;
  maxSdkVersion?: number;
  usesPermissionFlags?: string;
};

/** The base permissions of plan §4.13. Single source for the plugin, its tests and the bare guide. */
export function blePermissions(props: ExpoBleKitPluginProps = {}): PermissionDeclaration[] {
  const neverForLocation = props.android?.neverForLocation ?? true;
  return [
    { name: 'android.permission.BLUETOOTH', maxSdkVersion: 30 },
    { name: 'android.permission.BLUETOOTH_ADMIN', maxSdkVersion: 30 },
    // Without neverForLocation, Android 12+ also needs location permission to scan.
    neverForLocation
      ? { name: 'android.permission.ACCESS_FINE_LOCATION', maxSdkVersion: 30 }
      : { name: 'android.permission.ACCESS_FINE_LOCATION' },
    neverForLocation
      ? { name: 'android.permission.BLUETOOTH_SCAN', usesPermissionFlags: 'neverForLocation' }
      : { name: 'android.permission.BLUETOOTH_SCAN' },
    { name: 'android.permission.BLUETOOTH_CONNECT' },
  ];
}

/**
 * `android.foregroundService` (P3-03, plan §4.13): the permissions of the keep-alive service. Android
 * 13+ only shows its notification in the drawer with POST_NOTIFICATIONS, which the app requests.
 */
export function foregroundServicePermissions(): PermissionDeclaration[] {
  return [
    { name: 'android.permission.FOREGROUND_SERVICE' },
    { name: 'android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE' },
    { name: 'android.permission.POST_NOTIFICATIONS' },
  ];
}

/**
 * `android.backgroundLocation` (P3-04, plan §4.13): background scans on Android 10 and 11 need
 * background location; Android 12+ scans in the background with BLUETOOTH_SCAN alone.
 */
export const BACKGROUND_LOCATION: PermissionDeclaration = {
  name: 'android.permission.ACCESS_BACKGROUND_LOCATION',
  maxSdkVersion: 30,
};

/** `android.advertise` (P4-03, plan §4.13): advertising needs BLUETOOTH_ADVERTISE on Android 12+. */
export const ADVERTISE: PermissionDeclaration = { name: 'android.permission.BLUETOOTH_ADVERTISE' };

/** The keep-alive service class (plan §4.4), declared only with `android.foregroundService`. */
export const CONNECTION_SERVICE = 'expo.modules.blekit.core.ConnectionService';

/**
 * `android.companionDevice` (P5-05): CompanionDeviceManager refuses apps that don't declare its
 * feature, presence observation needs the permission, and Android binds the presence service while
 * an observed device is in range.
 */
export const COMPANION_FEATURE = 'android.software.companion_device_setup';
export const COMPANION_PRESENCE: PermissionDeclaration = {
  name: 'android.permission.REQUEST_OBSERVE_COMPANION_DEVICE_PRESENCE',
};
export const COMPANION_SERVICE = 'expo.modules.blekit.binding.CompanionPresenceService';

export const BLE_FEATURE = 'android.hardware.bluetooth_le';
/**
 * Declared explicitly because the legacy BLUETOOTH permission implies it as *required*, which would
 * hide the app on Google Play from devices without classic Bluetooth.
 */
export const BLUETOOTH_FEATURE = 'android.hardware.bluetooth';
/** Implied as required by ACCESS_FINE_LOCATION; declared optional only when this plugin adds that permission. */
export const LOCATION_FEATURE = 'android.hardware.location';
const FINE_LOCATION = 'android.permission.ACCESS_FINE_LOCATION';

type ManifestItem = { $: Record<string, string> };
type ApplicationItem = ManifestItem & { service?: ManifestItem[] };

function addService(root: Record<string, ManifestItem[] | undefined>, service: ManifestItem) {
  root.application ??= [{ $: {} }];
  const application = root.application[0] as ApplicationItem;
  application.service ??= [];
  if (!application.service.some((item) => item.$['android:name'] === service.$['android:name'])) {
    application.service.push(service);
  }
}

/**
 * Adds the base declarations to a parsed AndroidManifest. Entries another plugin or the app already
 * declared are left exactly as they are (plan §4.15): adding `maxSdkVersion` to an existing location
 * permission would remove location access on Android 12+ for apps that need it.
 */
export function applyAndroidManifest(
  manifest: AndroidConfig.Manifest.AndroidManifest,
  props: ExpoBleKitPluginProps = {}
): AndroidConfig.Manifest.AndroidManifest {
  const root = manifest.manifest as unknown as Record<string, ManifestItem[] | undefined> & {
    $: Record<string, string>;
  };
  root['uses-permission'] ??= [];
  const permissions = root['uses-permission'];
  const declared = new Set(permissions.map((item) => item.$['android:name']));

  const addsLocation = !declared.has(FINE_LOCATION);
  const foregroundService = props.android?.foregroundService ?? false;
  const companionDevice = props.android?.companionDevice ?? false;
  for (const permission of [
    ...blePermissions(props),
    ...(foregroundService ? foregroundServicePermissions() : []),
    ...(props.android?.backgroundLocation ? [BACKGROUND_LOCATION] : []),
    ...(props.android?.advertise ? [ADVERTISE] : []),
    ...(companionDevice ? [COMPANION_PRESENCE] : []),
  ]) {
    if (declared.has(permission.name)) {
      continue;
    }
    const attributes: Record<string, string> = { 'android:name': permission.name };
    if (permission.maxSdkVersion !== undefined) {
      attributes['android:maxSdkVersion'] = String(permission.maxSdkVersion);
    }
    if (permission.usesPermissionFlags !== undefined) {
      attributes['android:usesPermissionFlags'] = permission.usesPermissionFlags;
      attributes['tools:targetApi'] = 's';
      root.$['xmlns:tools'] ??= 'http://schemas.android.com/tools';
    }
    permissions.push({ $: attributes });
  }

  root['uses-feature'] ??= [];
  const features = root['uses-feature'];
  const required = String(props.android?.requireBleHardware ?? false);
  for (const feature of [BLUETOOTH_FEATURE, BLE_FEATURE]) {
    if (!features.some((item) => item.$['android:name'] === feature)) {
      features.push({ $: { 'android:name': feature, 'android:required': required } });
    }
  }
  // Our location permission only exists for scanning on Android 11 and older, so it must not make
  // location hardware a Play Store requirement. If the app declared location itself, it owns this.
  if (addsLocation && !features.some((item) => item.$['android:name'] === LOCATION_FEATURE)) {
    features.push({ $: { 'android:name': LOCATION_FEATURE, 'android:required': 'false' } });
  }

  if (companionDevice && !features.some((item) => item.$['android:name'] === COMPANION_FEATURE)) {
    // Not required: the app stays on Google Play for devices without it (NOT_SUPPORTED there).
    features.push({ $: { 'android:name': COMPANION_FEATURE, 'android:required': 'false' } });
  }

  if (foregroundService) {
    addService(root, {
      $: {
        'android:name': CONNECTION_SERVICE,
        'android:exported': 'false',
        'android:foregroundServiceType': 'connectedDevice',
      },
    });
  }
  if (companionDevice) {
    // Exported for the system, which alone holds BIND_COMPANION_DEVICE_SERVICE.
    addService(root, {
      $: {
        'android:name': COMPANION_SERVICE,
        'android:exported': 'true',
        'android:permission': 'android.permission.BIND_COMPANION_DEVICE_SERVICE',
      },
      'intent-filter': [
        { action: [{ $: { 'android:name': 'android.companion.CompanionDeviceService' } }] },
      ],
    } as ManifestItem);
  }
  return manifest;
}

/** Raises `android.minSdkVersion` to MIN_ANDROID_SDK when absent or lower. Never lowers it. */
export function applyGradleProperties(
  properties: AndroidConfig.Properties.PropertiesItem[]
): AndroidConfig.Properties.PropertiesItem[] {
  const existing = properties.find(
    (item) => item.type === 'property' && item.key === MIN_SDK_PROPERTY
  );
  if (!existing) {
    properties.push({ type: 'property', key: MIN_SDK_PROPERTY, value: String(MIN_ANDROID_SDK) });
  } else if (existing.type === 'property' && !(Number(existing.value) >= MIN_ANDROID_SDK)) {
    existing.value = String(MIN_ANDROID_SDK);
  }
  return properties;
}

/**
 * Runs in the finalized mod, after every other plugin has written the native files, so the result is
 * the same whichever order the app lists its plugins in (plan §4.15).
 */
export const withBleKitAndroid: ConfigPlugin<ExpoBleKitPluginProps> = (config, props) =>
  withFinalizedMod(config, [
    'android',
    async (config) => {
      const projectRoot = config.modRequest.projectRoot;
      const manifestPath = await AndroidConfig.Paths.getAndroidManifestAsync(projectRoot);
      const manifest = await AndroidConfig.Manifest.readAndroidManifestAsync(manifestPath);
      await AndroidConfig.Manifest.writeAndroidManifestAsync(
        manifestPath,
        applyAndroidManifest(manifest, props)
      );

      const propertiesPath = join(config.modRequest.platformProjectRoot, 'gradle.properties');
      const contents = await fs.readFile(propertiesPath, 'utf8');
      const properties = applyGradleProperties(
        AndroidConfig.Properties.parsePropertiesFile(contents)
      );
      await fs.writeFile(
        propertiesPath,
        AndroidConfig.Properties.propertiesListToString(properties)
      );
      return config;
    },
  ]);
