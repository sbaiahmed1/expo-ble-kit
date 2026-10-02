import { readFileSync } from 'fs';
import { resolve } from 'path';

import { BleError } from '../errors';
import type { BlePermissions, BleState, PermissionStatus } from '../types';

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const swiftState = read('ios/Core/AdapterState.swift');
const kotlinState = read('android/src/main/java/expo/modules/blekit/core/BleState.kt');
const kotlinPermissions = read('android/src/main/java/expo/modules/blekit/core/Permissions.kt');

/** Lists every member of a string union; fails to compile when one is missing. */
function allOf<T extends string>() {
  return <const L extends readonly T[]>(
    list: L & ([Exclude<T, L[number]>] extends [never] ? unknown : never)
  ) => [...list].sort();
}

/** The string cases of a Swift enum. */
function swiftCases(source: string, name: string): string[] {
  const body = new RegExp(`enum ${name}: String \\{([^}]*)\\}`).exec(source)?.[1] ?? '';
  return [...body.matchAll(/case (\w+)/g)].map((m) => m[1]).sort();
}

/** The `js` values of a Kotlin enum. */
function kotlinValues(source: string, name: string): string[] {
  const body =
    new RegExp(`enum class ${name}\\(val js: String\\) \\{([^;}]*)[;}]`).exec(source)?.[1] ?? '';
  return [...body.matchAll(/\w+\("(\w+)"\)/g)].map((m) => m[1]).sort();
}

describe('native values match the public types (plan §5.1)', () => {
  it('BleState', () => {
    const states = allOf<BleState>()([
      'unknown',
      'resetting',
      'unsupported',
      'unauthorized',
      'poweredOff',
      'poweredOn',
    ]);
    expect(swiftCases(swiftState, 'BleState')).toEqual(states);
    expect(kotlinValues(kotlinState, 'BleState')).toEqual(states);
  });

  it('PermissionStatus', () => {
    const statuses = allOf<PermissionStatus>()(['granted', 'denied', 'undetermined']);
    expect(swiftCases(swiftState, 'PermissionStatus')).toEqual(statuses);
    expect(kotlinValues(kotlinPermissions, 'PermissionStatus')).toEqual(statuses);
  });

  it('BlePermissions keys', () => {
    const keys = allOf<keyof BlePermissions>()([
      'scan',
      'connect',
      'advertise',
      'backgroundScan',
      'canAskAgain',
    ]);
    const swiftKeys = [...swiftState.matchAll(/^\s+"(\w+)": /gm)].map((m) => m[1]).sort();
    expect(swiftKeys).toEqual(keys);
    // Kotlin builds the map from the capability names plus canAskAgain.
    expect([...kotlinValues(kotlinPermissions, 'BleCapability'), 'canAskAgain'].sort()).toEqual(
      keys
    );
  });
});

describe('native error messages', () => {
  it.each([
    [
      'iOS',
      'Read failed [blekit]{"nativeCode":14,"nativeDomain":"CBATTErrorDomain","retryable":false}',
      { nativeCode: 14, nativeDomain: 'CBATTErrorDomain', retryable: false },
    ],
    [
      'Android',
      'Write failed [blekit]{"gattStatus":133,"retryable":true}',
      { gattStatus: 133, retryable: true },
    ],
  ])('parses the %s format (same strings as the native tests)', (_, message, details) => {
    const error = BleError.fromNative(Object.assign(new Error(message), { code: 'GATT_ERROR' }));
    expect(error.message).toBe(message.replace(/ \[blekit\].*/, ''));
    expect(error).toMatchObject(details);
  });
});
