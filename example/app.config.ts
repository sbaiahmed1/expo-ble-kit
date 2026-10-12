import type { ConfigContext, ExpoConfig } from 'expo/config';

// P5-04: `EXPO_BLE_KIT_ASK=1 npx expo prebuild` builds a separate app (its own bundle id, so iOS keeps
// its Bluetooth permission apart) with AccessorySetupKit declared for the test peripheral's
// service. Installed next to the normal build, it shows what declaring AccessorySetupKit changes:
// docs/guides/accessory-setup.md.

const TEST_SERVICE = '0c6c1000-b347-4cfa-9827-1c5a13658519';

export default ({ config }: ConfigContext): ExpoConfig => {
  const base = config as ExpoConfig;
  if (process.env.EXPO_BLE_KIT_ASK !== '1') return base;
  return {
    ...base,
    name: 'BLE Kit ASK',
    ios: { ...base.ios, bundleIdentifier: 'expo.modules.blekit.example.ask' },
    plugins: (base.plugins ?? []).map((plugin) => {
      if (!Array.isArray(plugin) || plugin[0] !== '../app.plugin.js') return plugin;
      const options = plugin[1] ?? {};
      return [
        plugin[0],
        {
          ...options,
          ios: {
            ...options.ios,
            // 0xFFFF is the Bluetooth SIG's company id for tests: declared so this build also
            // checks the form the plugin writes company ids in.
            accessorySetupKit: {
              services: [TEST_SERVICE],
              names: ['BleKit'],
              companyIdentifiers: [0xffff],
            },
          },
        },
      ];
    }),
  };
};
