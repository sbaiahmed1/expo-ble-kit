// Reexport the native module. On web, it will be resolved to ExpoBleKitModule.web.ts
// and on native platforms to ExpoBleKitModule.ts
export { default } from './ExpoBleKitModule';
export * from './ExpoBleKit.types';
export * from './ExpoBleKitModuleSharedObject';
export { BleError, BleErrorCode } from './errors';
export type { BleErrorDetails } from './errors';
