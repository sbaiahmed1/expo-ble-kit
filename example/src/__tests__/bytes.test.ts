import { fromUtf8, parseHex, toHex, toUtf8 } from '../lib/bytes';

describe('bytes', () => {
  it('formats and parses hex', () => {
    expect(toHex(Uint8Array.of(0, 31, 160))).toBe('00 1f a0');
    for (const input of ['001fa0', '00 1f a0', '0x00,0x1F,0xA0', '00:1f:a0']) {
      expect(parseHex(input)).toEqual(Uint8Array.of(0, 31, 160));
    }
    expect(parseHex('')).toEqual(new Uint8Array());
    expect(() => parseHex('abc')).toThrow(/pairs/);
    expect(() => parseHex('zz')).toThrow(/pairs/);
  });

  it('round-trips UTF-8, including multi-byte characters', () => {
    for (const text of ['hello', 'é', '€', '😀 ok']) {
      expect(toUtf8(fromUtf8(text))).toBe(text);
    }
    expect(fromUtf8('€')).toEqual(Uint8Array.of(0xe2, 0x82, 0xac));
  });

  it('shows invalid bytes and control characters', () => {
    expect(toUtf8(Uint8Array.of(0x41, 0xff, 0x42))).toBe('A�B');
    expect(toUtf8(Uint8Array.of(0xe2, 0x82))).toBe('��');
    expect(toUtf8(Uint8Array.of(0x00, 0x41, 0x0a))).toBe('·A·');
  });
});
