import { ConfigPlugin, createRunOncePlugin, withGradleProperties } from 'expo/config-plugins';

/** ADR-002: the Android core relies on API 26+ calls. */
export const MIN_ANDROID_SDK = 26;

const MIN_SDK_PROPERTY = 'android.minSdkVersion';

/**
 * Raises `android.minSdkVersion` in gradle.properties to MIN_ANDROID_SDK when it is absent or lower.
 * Never lowers a higher value. Expo autolinking reads this property into its version catalog.
 */
export const withAndroidMinSdk: ConfigPlugin = (config) =>
  withGradleProperties(config, (config) => {
    const existing = config.modResults.find(
      (item) => item.type === 'property' && item.key === MIN_SDK_PROPERTY
    );
    if (!existing) {
      config.modResults.push({
        type: 'property',
        key: MIN_SDK_PROPERTY,
        value: String(MIN_ANDROID_SDK),
      });
    } else if (existing.type === 'property' && !(Number(existing.value) >= MIN_ANDROID_SDK)) {
      existing.value = String(MIN_ANDROID_SDK);
    }
    return config;
  });

const withExpoBleKit: ConfigPlugin = (config) => withAndroidMinSdk(config);

export default createRunOncePlugin(withExpoBleKit, 'expo-ble-kit');
