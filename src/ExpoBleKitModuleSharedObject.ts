import { SharedObject, useReleasingSharedObject } from 'expo-modules-core';

import ExpoBleKitModule from './ExpoBleKitModule';

export declare class ExpoBleKitModuleSharedObject extends SharedObject {
  count: number;
}

/**
 * Creates a new ExpoBleKitModuleSharedObject instance.
 * You are responsible for releasing it from memory by calling `release()` when done.
 */
export function createExpoBleKitModuleSharedObject(): ExpoBleKitModuleSharedObject {
  return new ExpoBleKitModule.ExpoBleKitModuleSharedObject();
}

/**
 * A hook that creates a ExpoBleKitModuleSharedObject instance and automatically
 * releases it when the component unmounts.
 */
export function useExpoBleKitModuleSharedObject(): ExpoBleKitModuleSharedObject {
  return useReleasingSharedObject(() => new ExpoBleKitModule.ExpoBleKitModuleSharedObject(), []);
}
