import type { ExpoConfig } from 'expo/config';
import {
  AndroidConfig,
  ConfigPlugin,
  compileModsAsync,
  withGradleProperties,
  XML,
} from 'expo/config-plugins';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import withExpoBleKit from '..';
import {
  BLE_FEATURE,
  BLUETOOTH_FEATURE,
  LOCATION_FEATURE,
  MIN_ANDROID_SDK,
  applyAndroidManifest,
  applyGradleProperties,
  BACKGROUND_LOCATION,
  blePermissions,
  CONNECTION_SERVICE,
  foregroundServicePermissions,
} from '../android';
import { BLUETOOTH_ALWAYS_KEY, DEFAULT_BLUETOOTH_ALWAYS_PERMISSION, applyInfoPlist } from '../ios';
import { validateProps } from '../schema';

const TEMPLATE_MANIFEST = `<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools">
  <uses-permission android:name="android.permission.INTERNET"/>
  <application android:name=".MainApplication" android:label="@string/app_name"/>
</manifest>
`;

async function parseManifest(xml: string): Promise<AndroidConfig.Manifest.AndroidManifest> {
  return (await XML.parseXMLAsync(xml)) as unknown as AndroidConfig.Manifest.AndroidManifest;
}

function permissionsOf(manifest: AndroidConfig.Manifest.AndroidManifest) {
  return (manifest.manifest['uses-permission'] ?? []).map((item) => item.$);
}

describe('validateProps', () => {
  it('accepts nothing or the supported options', () => {
    expect(validateProps(undefined)).toEqual({});
    expect(
      validateProps({
        bluetoothAlwaysPermission: false,
        android: { neverForLocation: false, requireBleHardware: true, foregroundService: true },
      })
    ).toEqual({
      bluetoothAlwaysPermission: false,
      android: { neverForLocation: false, requireBleHardware: true, foregroundService: true },
    });
  });

  it.each([
    [{ bluetoothPermission: 'typo' }, 'unknown option "bluetoothPermission"'],
    [{ android: { neverForLocations: true } }, 'unknown option "android.neverForLocations"'],
    [{ ios: { restoreIdentifier: 'x' } }, '"ios" is not available in this version yet'],
    [{ android: { companionDevice: true } }, '"android.companionDevice" is not available'],
    [{ android: { backgroundLocation: 1 } }, '"android.backgroundLocation" must be a boolean'],
    [{ android: { foregroundService: 'yes' } }, '"android.foregroundService" must be a boolean'],
    [{ bluetoothAlwaysPermission: 3 }, 'must be a string or false'],
    [{ android: { requireBleHardware: 'yes' } }, '"android.requireBleHardware" must be a boolean'],
    ['oops', 'options must be an object'],
  ])('rejects %p', (props, message) => {
    expect(() => validateProps(props)).toThrow(message);
  });
});

describe('iOS Info.plist', () => {
  it('adds the default description only when the app has none', () => {
    expect(applyInfoPlist({})).toEqual({
      [BLUETOOTH_ALWAYS_KEY]: DEFAULT_BLUETOOTH_ALWAYS_PERMISSION,
    });
    expect(applyInfoPlist({ [BLUETOOTH_ALWAYS_KEY]: 'Mine' })).toEqual({
      [BLUETOOTH_ALWAYS_KEY]: 'Mine',
    });
  });

  it('uses an explicit string and skips the key with false', () => {
    expect(
      applyInfoPlist({ [BLUETOOTH_ALWAYS_KEY]: 'Old' }, { bluetoothAlwaysPermission: 'New' })
    ).toEqual({ [BLUETOOTH_ALWAYS_KEY]: 'New' });
    expect(applyInfoPlist({}, { bluetoothAlwaysPermission: false })).toEqual({});
  });
});

describe('Android manifest', () => {
  it('adds the base declarations to the template manifest', async () => {
    const manifest = applyAndroidManifest(await parseManifest(TEMPLATE_MANIFEST));
    expect(XML.format(manifest)).toMatchSnapshot();
  });

  it('follows the options', async () => {
    const manifest = applyAndroidManifest(await parseManifest(TEMPLATE_MANIFEST), {
      android: { neverForLocation: false, requireBleHardware: true },
    });
    const scan = permissionsOf(manifest).find(
      (p) => p['android:name'] === 'android.permission.BLUETOOTH_SCAN'
    );
    expect(scan).toEqual({ 'android:name': 'android.permission.BLUETOOTH_SCAN' });
    // Scanning without neverForLocation needs location on Android 12+, so no maxSdkVersion.
    const location = permissionsOf(manifest).find(
      (p) => p['android:name'] === 'android.permission.ACCESS_FINE_LOCATION'
    );
    expect(location).toEqual({ 'android:name': 'android.permission.ACCESS_FINE_LOCATION' });
    expect(manifest.manifest['uses-feature']).toEqual([
      { $: { 'android:name': BLUETOOTH_FEATURE, 'android:required': 'true' } },
      { $: { 'android:name': BLE_FEATURE, 'android:required': 'true' } },
      { $: { 'android:name': LOCATION_FEATURE, 'android:required': 'false' } },
    ]);
  });

  it('never changes an entry the app or another plugin already declared', async () => {
    const manifest = await parseManifest(
      TEMPLATE_MANIFEST.replace(
        '<uses-permission android:name="android.permission.INTERNET"/>',
        '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"/>\n  <uses-permission android:name="android.permission.BLUETOOTH_SCAN"/>'
      )
    );
    const permissions = permissionsOf(applyAndroidManifest(manifest));
    expect(permissions.filter((p) => p['android:name'].endsWith('ACCESS_FINE_LOCATION'))).toEqual([
      { 'android:name': 'android.permission.ACCESS_FINE_LOCATION' },
    ]);
    expect(permissions.filter((p) => p['android:name'].endsWith('BLUETOOTH_SCAN'))).toEqual([
      { 'android:name': 'android.permission.BLUETOOTH_SCAN' },
    ]);
    const features = (manifest.manifest['uses-feature'] ?? []).map((f) => f.$['android:name']);
    expect(features).not.toContain(LOCATION_FEATURE);
  });

  it('is idempotent', async () => {
    const once = XML.format(applyAndroidManifest(await parseManifest(TEMPLATE_MANIFEST)));
    const twice = XML.format(
      applyAndroidManifest(applyAndroidManifest(await parseManifest(TEMPLATE_MANIFEST)))
    );
    expect(twice).toBe(once);
  });

  it('android.backgroundLocation declares background location up to Android 11', async () => {
    const without = permissionsOf(applyAndroidManifest(await parseManifest(TEMPLATE_MANIFEST)));
    expect(without.map((p) => p['android:name'])).not.toContain(BACKGROUND_LOCATION.name);
    const manifest = applyAndroidManifest(await parseManifest(TEMPLATE_MANIFEST), {
      android: { backgroundLocation: true },
    });
    expect(
      permissionsOf(manifest).filter((p) => p['android:name'] === BACKGROUND_LOCATION.name)
    ).toEqual([{ 'android:name': BACKGROUND_LOCATION.name, 'android:maxSdkVersion': '30' }]);
    // An app that declared it itself (for location features) keeps its entry, uncapped.
    const own = await parseManifest(
      TEMPLATE_MANIFEST.replace(
        'android.permission.INTERNET',
        'android.permission.ACCESS_BACKGROUND_LOCATION'
      )
    );
    expect(
      permissionsOf(applyAndroidManifest(own, { android: { backgroundLocation: true } })).filter(
        (p) => p['android:name'] === BACKGROUND_LOCATION.name
      )
    ).toEqual([{ 'android:name': BACKGROUND_LOCATION.name }]);
  });

  describe('android.foregroundService', () => {
    const props = { android: { foregroundService: true } };

    it('declares the keep-alive service and its permissions', async () => {
      const manifest = applyAndroidManifest(await parseManifest(TEMPLATE_MANIFEST), props);
      expect(XML.format(manifest)).toMatchSnapshot();
      const once = XML.format(manifest);
      expect(XML.format(applyAndroidManifest(manifest, props))).toBe(once);
    });

    it('adds nothing without the option', async () => {
      const manifest = applyAndroidManifest(await parseManifest(TEMPLATE_MANIFEST));
      const names = permissionsOf(manifest).map((p) => p['android:name']);
      for (const permission of foregroundServicePermissions()) {
        expect(names).not.toContain(permission.name);
      }
      expect(XML.format(manifest)).not.toContain(CONNECTION_SERVICE);
    });

    it('keeps a service or permission the app already declared', async () => {
      const manifest = await parseManifest(
        TEMPLATE_MANIFEST.replace(
          '<application android:name=".MainApplication" android:label="@string/app_name"/>',
          `<uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>
  <application android:name=".MainApplication" android:label="@string/app_name">
    <service android:name="${CONNECTION_SERVICE}" android:exported="false" android:foregroundServiceType="connectedDevice" android:stopWithTask="true"/>
  </application>`
        )
      );
      const result = XML.format(applyAndroidManifest(manifest, props));
      expect(result.match(/POST_NOTIFICATIONS/g)).toHaveLength(1);
      expect(result.match(/ConnectionService/g)).toHaveLength(1);
      expect(result).toContain('android:stopWithTask="true"');
    });
  });
});

describe('Android gradle.properties', () => {
  const minSdk = (props: AndroidConfig.Properties.PropertiesItem[]) =>
    props.find((p) => p.type === 'property' && p.key === 'android.minSdkVersion');

  it('adds or raises the minimum SDK but never lowers it', () => {
    expect(minSdk(applyGradleProperties([]))).toMatchObject({ value: String(MIN_ANDROID_SDK) });
    const low: AndroidConfig.Properties.PropertiesItem[] = [
      { type: 'property', key: 'android.minSdkVersion', value: '24' },
    ];
    expect(minSdk(applyGradleProperties(low))).toMatchObject({ value: '26' });
    const high: AndroidConfig.Properties.PropertiesItem[] = [
      { type: 'property', key: 'android.minSdkVersion', value: '28' },
    ];
    expect(minSdk(applyGradleProperties(high))).toMatchObject({ value: '28' });
  });
});

// Stand-ins for expo-location and expo-build-properties, using the same config-plugin APIs.
const withFakeLocation: ConfigPlugin = (config) =>
  AndroidConfig.Permissions.withPermissions(config, [
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION',
  ]);
const withFakeBuildProperties: ConfigPlugin = (config) =>
  withGradleProperties(config, (config) => {
    config.modResults = config.modResults.filter(
      (p) => !(p.type === 'property' && p.key === 'android.minSdkVersion')
    );
    config.modResults.push({ type: 'property', key: 'android.minSdkVersion', value: '24' });
    return config;
  });

describe('prebuild (real mod pipeline)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'blekit-plugin-'));
    mkdirSync(join(projectRoot, 'android/app/src/main'), { recursive: true });
    writeFileSync(join(projectRoot, 'android/app/src/main/AndroidManifest.xml'), TEMPLATE_MANIFEST);
    writeFileSync(join(projectRoot, 'android/gradle.properties'), 'org.gradle.jvmargs=-Xmx2048m\n');
  });

  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  async function prebuild(plugins: ConfigPlugin[]) {
    let config: ExpoConfig = { name: 'test', slug: 'test' };
    for (const plugin of plugins) {
      config = plugin(config) as ExpoConfig;
    }
    await compileModsAsync(config, {
      projectRoot,
      platforms: ['android'],
      assertMissingModProviders: false,
    });
    return {
      manifest: await AndroidConfig.Manifest.readAndroidManifestAsync(
        join(projectRoot, 'android/app/src/main/AndroidManifest.xml')
      ),
      gradleProperties: readFileSync(join(projectRoot, 'android/gradle.properties'), 'utf8'),
    };
  }

  it('gives identical results whichever order the plugins are listed in', async () => {
    const results: string[] = [];
    for (const plugins of [
      [withExpoBleKit, withFakeLocation, withFakeBuildProperties],
      [withFakeLocation, withFakeBuildProperties, withExpoBleKit],
    ]) {
      writeFileSync(
        join(projectRoot, 'android/app/src/main/AndroidManifest.xml'),
        TEMPLATE_MANIFEST
      );
      writeFileSync(
        join(projectRoot, 'android/gradle.properties'),
        'org.gradle.jvmargs=-Xmx2048m\n'
      );
      const { manifest, gradleProperties } = await prebuild(plugins);
      // The location plugin's entry keeps no maxSdkVersion, so location still works on Android 12+.
      const location = permissionsOf(manifest).filter((p) =>
        p['android:name'].endsWith('ACCESS_FINE_LOCATION')
      );
      expect(location).toEqual([{ 'android:name': 'android.permission.ACCESS_FINE_LOCATION' }]);
      // expo-build-properties' lower minSdk is raised back to 26.
      expect(gradleProperties).toContain('android.minSdkVersion=26');
      expect(gradleProperties).not.toContain('android.minSdkVersion=24');
      results.push(XML.format(manifest) + '\n' + gradleProperties);
    }
    expect(results[1]).toBe(results[0]);
    expect(results[0]).toMatchSnapshot();
  });

  it('does not duplicate anything when prebuild runs twice', async () => {
    await prebuild([withExpoBleKit]);
    const first = readFileSync(
      join(projectRoot, 'android/app/src/main/AndroidManifest.xml'),
      'utf8'
    );
    await prebuild([withExpoBleKit]);
    const second = readFileSync(
      join(projectRoot, 'android/app/src/main/AndroidManifest.xml'),
      'utf8'
    );
    expect(second).toBe(first);
  });
});

describe('bare setup guide', () => {
  const guide = readFileSync(resolve(__dirname, '../../../docs/guides/bare-setup.md'), 'utf8');

  const keepAliveSection = guide.indexOf('## Android: keep-alive foreground service');
  const permissionsIn = (text: string) =>
    [...text.matchAll(/<uses-permission ([^>]*?)\s*\/>/g)].map((m) =>
      Object.fromEntries([...m[1].matchAll(/([\w:]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]))
    );

  it('lists exactly the permissions the plugin writes', () => {
    const fromGuide = permissionsIn(guide.slice(0, keepAliveSection));
    const fromPlugin = blePermissions().map((p) => ({
      'android:name': p.name,
      ...(p.maxSdkVersion !== undefined && { 'android:maxSdkVersion': String(p.maxSdkVersion) }),
      ...(p.usesPermissionFlags !== undefined && {
        'android:usesPermissionFlags': p.usesPermissionFlags,
        'tools:targetApi': 's',
      }),
    }));
    expect(fromGuide).toEqual(fromPlugin);
  });

  it('lists the keep-alive service entries of android.foregroundService', () => {
    const section = guide.slice(keepAliveSection, guide.indexOf('## Android: background scans'));
    expect(permissionsIn(section)).toEqual(
      foregroundServicePermissions().map((p) => ({ 'android:name': p.name }))
    );
    expect(section).toContain(
      `<service android:name="${CONNECTION_SERVICE}" android:exported="false" android:foregroundServiceType="connectedDevice" />`
    );
  });

  it('lists the background location entry of android.backgroundLocation', () => {
    const section = guide.slice(
      guide.indexOf('## Android: background scans'),
      guide.indexOf('## Android: minimum SDK')
    );
    expect(permissionsIn(section)).toEqual([
      { 'android:name': BACKGROUND_LOCATION.name, 'android:maxSdkVersion': '30' },
    ]);
  });

  it('lists the feature, the Info.plist key and the minimum SDK', () => {
    for (const feature of [BLUETOOTH_FEATURE, BLE_FEATURE, LOCATION_FEATURE]) {
      expect(guide).toContain(
        `<uses-feature android:name="${feature}" android:required="false" />`
      );
    }
    expect(guide).toContain(`<key>${BLUETOOTH_ALWAYS_KEY}</key>`);
    expect(guide).toContain(`<string>${DEFAULT_BLUETOOTH_ALWAYS_PERMISSION}</string>`);
    expect(guide).toContain(`minSdkVersion = ${MIN_ANDROID_SDK}`);
  });
});
