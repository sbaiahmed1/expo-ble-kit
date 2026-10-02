# Bare React Native setup

Apps that use Continuous Native Generation (`npx expo prebuild`) get all of this from the config plugin:

```json
{ "expo": { "plugins": ["expo-ble-kit"] } }
```

Bare React Native apps (with `expo` installed but without prebuild) don't run config plugins, so add these entries by hand. They are exactly what the plugin writes with its default options; a test in `plugin/src/__tests__` keeps this page in sync with the plugin.

The library itself declares no permissions (plan §4.15). If an entry is missing, the library rejects with `MISCONFIGURED` and names the entry, instead of crashing.

## iOS: `Info.plist`

```xml
<key>NSBluetoothAlwaysUsageDescription</key>
<string>Allow $(PRODUCT_NAME) to use Bluetooth to connect to nearby devices.</string>
```

Write your own sentence: App Review reads it.

## Android: `android/app/src/main/AndroidManifest.xml`

Inside `<manifest>`, which must declare `xmlns:tools="http://schemas.android.com/tools"`:

```xml
<uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />
<uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" android:maxSdkVersion="30" />
<uses-permission android:name="android.permission.BLUETOOTH_SCAN" android:usesPermissionFlags="neverForLocation" tools:targetApi="s" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<uses-feature android:name="android.hardware.bluetooth" android:required="false" />
<uses-feature android:name="android.hardware.bluetooth_le" android:required="false" />
<uses-feature android:name="android.hardware.location" android:required="false" />
```

- If your app already declares one of these permissions (for example `ACCESS_FINE_LOCATION` for location features), keep your entry and skip this one. In particular, don't add `maxSdkVersion` to a location permission your app needs on Android 12+. In that case also skip the `android.hardware.location` line: your app decides whether location hardware is required.
- `neverForLocation` tells Android 12+ that your app doesn't derive location from scans. Without it, Android requires location permission for scanning. Drop the flag only if you do derive location from Bluetooth scans; some beacon advertisements are filtered while it is set. Without the flag, also remove `android:maxSdkVersion` from `ACCESS_FINE_LOCATION`; `requestPermissionsAsync` then asks for location too.
- The `android.hardware.bluetooth` line matters: the legacy `BLUETOOTH` permission otherwise makes Google Play treat classic Bluetooth as *required*. Set `android:required="true"` on both features only if the app is useless without Bluetooth LE: Play then hides it from devices without it.

## Android: minimum SDK 26

The library needs Android 8.0 (API 26). In `android/build.gradle`, set `minSdkVersion = 26` in `ext` (or `android.minSdkVersion=26` in `android/gradle.properties` for Expo autolinking projects).
