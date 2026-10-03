import { readFileSync } from 'fs';
import { resolve } from 'path';

import * as api from '../index';

// P1-12: the public surface is exactly plan §5 (Appendix B rule 8). Members that later tasks own
// are listed here with their task, and removed from this list when they land.

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const LATER: Record<string, Record<string, string>> = {
  BleManagerApi: {
    openGattServer: 'P4-01',
    startAdvertising: 'P4-03',
    registerBackgroundTask: 'P3-02',
    unregisterBackgroundTask: 'P3-02',
    ios: 'P5-04',
  },
  Peripheral: {
    openL2CAPChannel: 'P5-03',
  },
};

/** Interfaces of the later tasks themselves (P2–P5), not yet in src/types.ts. */
const LATER_INTERFACES = new Set([
  'L2CAPChannel',
  'ServiceDefinition',
  'CharacteristicDefinition',
  'ReadRequest',
  'WriteRequest',
  'GattServer',
  'AdvertisingData',
  'AdvertisingOptions',
  'Advertisement',
  'BackgroundTaskOptions',
  'AccessoryPickerItem',
  'CompanionDeviceFilter',
]);

/**
 * The top-level member names of each `interface Name … { … }` in `source`. Comments are dropped
 * and arrows (`=>`) rewritten first, so their `<` and `>` don't read as brackets.
 */
function interfaces(code: string): Map<string, string[]> {
  const source = code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/=>/g, '=:');
  const found = new Map<string, string[]>();
  for (const match of source.matchAll(/interface (\w+)[^{]*\{/g)) {
    let depth = 1;
    let index = match.index! + match[0].length;
    let line = '';
    const members: string[] = [];
    const flush = () => {
      const member = /^\s*(?:readonly\s+)?(\w+)\??\s*[(:<]/.exec(line);
      if (member) members.push(member[1]);
      line = '';
    };
    for (; depth > 0 && index < source.length; index++) {
      const char = source[index];
      if (char === '{' || char === '(' || char === '<') depth++;
      if (char === '}' || char === ')' || char === '>') depth--;
      if (depth === 0 || (depth === 1 && (char === '\n' || char === ';'))) {
        flush();
      } else if (depth === 1 || (depth === 2 && '{(<'.includes(char))) {
        line += char;
      }
    }
    found.set(match[1], [...new Set(members)].sort());
  }
  return found;
}

describe('the public API matches plan §5', () => {
  const plan = read('docs/ARCHITECTURE_AND_PLAN.md');
  const section = plan.slice(plan.indexOf('## 5. Public API'), plan.indexOf('## 6. Platform'));
  const specified = interfaces(
    [...section.matchAll(/```ts\n([\s\S]*?)```/g)].map((block) => block[1]).join('\n')
  );
  const declared = interfaces(
    [read('src/types.ts'), read('src/testing/FakeBleAdapter.ts')].join('\n')
  );

  it.each([...specified.keys()].filter((name) => !LATER_INTERFACES.has(name)))('%s', (name) => {
    const later = Object.keys(LATER[name] ?? {});
    const expected = specified.get(name)!.filter((member) => !later.includes(member));
    expect(declared.get(name)).toEqual(expected);
  });

  it('exports exactly the §5 values', () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        'BleError',
        'BleErrorCode',
        'BleManager',
        'GattCharacteristics',
        'GattServices',
        'normalizeUUID',
        'useBlePermissions',
        'useBleState',
        'useCharacteristicValue',
        'usePeripheral',
        'useScan',
        'uuid16',
      ].sort()
    );
  });
});
