import { fromUtf8, parseHex } from './bytes';

// Values of test-peripherals/profile.json: a byte pattern, hex or UTF-8 (the demo peripheral and
// the GATT server checks build theirs from the same profile).

export type ProfileValue = {
  pattern?: { length: number; multiplier: number; offset: number; modulus: number };
  hex?: string;
  utf8?: string;
};

/** The bytes of a profile value; undefined without one. */
export function profileValue(value: ProfileValue | undefined): Uint8Array | undefined {
  if (!value) return undefined;
  if (value.pattern) {
    const { length, multiplier, offset, modulus } = value.pattern;
    return Uint8Array.from({ length }, (_, i) => (i * multiplier + offset) % modulus);
  }
  if (value.hex !== undefined) return parseHex(value.hex);
  if (value.utf8 !== undefined) return fromUtf8(value.utf8);
  return undefined;
}
