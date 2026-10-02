// Run with `yarn test plugin` (internal/module_scripts/test.js passes --rootDir plugin).
module.exports = {
  preset: 'jest-expo/node',
  transform: {
    '\\.[jt]sx?$': ['babel-jest', { presets: ['babel-preset-expo'] }],
  },
};
