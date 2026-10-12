import { readFileSync } from 'fs';
import { resolve } from 'path';

// P6-03: the heart rate recipe of the agent skill (skills/expo-ble-kit/references/heart-rate.md) is
// code an agent copies. Its blocks live in example/src/skillRecipes/heartRate, where the example's
// TypeScript and Jest check them (HeartRateScreen.test.tsx is the recipe's own test); this keeps
// both the same.

const recipe = readFileSync(
  resolve(__dirname, '../../skills/expo-ble-kit/references/heart-rate.md'),
  'utf8'
);
const blocks = [...recipe.matchAll(/```tsx?\n([\s\S]*?)```/g)].map((match) => match[1]);
const file = (name: string) =>
  readFileSync(resolve(__dirname, '../../example/src/skillRecipes/heartRate', name), 'utf8');

describe('the skill’s heart rate recipe', () => {
  it.each([
    ['parseHeartRate.ts', 'export function parseHeartRate'],
    ['HeartRateScreen.tsx', 'export function HeartRateScreen'],
    ['HeartRateScreen.test.tsx', "describe('HeartRateScreen'"],
  ])('%s is the recipe’s block', (name, marker) => {
    const block = blocks.find((code) => code.includes(marker));
    expect(block).toBeDefined();
    expect(file(name)).toBe(block);
  });
});
