import { mkdirSync, mkdtempSync, rmdirSync, symlinkSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import ts from 'typescript';

// P1-13: an app resolves `expo-ble-kit/testing` through the package's exports map, in Jest and in
// TypeScript. A throwaway consumer links the package into its node_modules, as an install would.
// Needs the build output (`yarn prepare`, which `yarn install` runs).

const root = resolve(__dirname, '../..');

describe('the expo-ble-kit/testing entry', () => {
  let consumer: string;
  let link: string;

  beforeAll(() => {
    consumer = mkdtempSync(join(tmpdir(), 'blekit-consumer-'));
    mkdirSync(join(consumer, 'node_modules'));
    link = join(consumer, 'node_modules', 'expo-ble-kit');
    symlinkSync(root, link, 'dir');
  });

  afterAll(() => {
    // Remove the link itself; never recurse through it into the package.
    unlinkSync(link);
    rmdirSync(join(consumer, 'node_modules'));
    rmdirSync(consumer);
  });

  it('resolves through the exports map in Jest', () => {
    expect(require.resolve('expo-ble-kit/testing', { paths: [consumer] })).toBe(
      join(root, 'build/testing/index.js')
    );
  });

  it('resolves to its types in TypeScript', () => {
    for (const moduleResolution of [
      ts.ModuleResolutionKind.Bundler,
      ts.ModuleResolutionKind.Node10,
    ]) {
      const { resolvedModule } = ts.resolveModuleName(
        'expo-ble-kit/testing',
        join(consumer, 'index.ts'),
        { moduleResolution, module: ts.ModuleKind.ESNext },
        ts.sys
      );
      expect(resolvedModule?.resolvedFileName).toBe(join(root, 'build/testing/index.d.ts'));
    }
  });
});
