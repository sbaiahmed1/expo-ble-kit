// Byte formatting for the screens: hex and UTF-8, both ways. Written by hand so it works on every
// JS engine without TextEncoder/TextDecoder.

/** `00 1f a0`. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

/** Accepts `001fa0`, `00 1f a0`, `0x00,0x1F,0xA0`. Throws on anything else. */
export function parseHex(text: string): Uint8Array {
  const digits = text.replace(/0x/gi, '').replace(/[\s,:-]/g, '');
  if (!/^[0-9a-f]*$/i.test(digits) || digits.length % 2 !== 0) {
    throw new Error('Hex needs pairs of 0-9 and a-f, like 01 ff');
  }
  return Uint8Array.from(digits.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

export function fromUtf8(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }
  return Uint8Array.from(bytes);
}

/** Decodes UTF-8; invalid bytes become U+FFFD and control characters a middle dot. */
export function toUtf8(bytes: Uint8Array): string {
  let text = '';
  let i = 0;
  while (i < bytes.length) {
    const first = bytes[i];
    const length =
      first < 0x80
        ? 1
        : first >> 5 === 0x6
          ? 2
          : first >> 4 === 0xe
            ? 3
            : first >> 3 === 0x1e
              ? 4
              : 0;
    const tail = bytes.subarray(i + 1, i + length);
    if (length === 0 || tail.length !== length - 1 || tail.some((byte) => byte >> 6 !== 0x2)) {
      text += '�';
      i += 1;
      continue;
    }
    let code = length === 1 ? first : first & (0xff >> (length + 1));
    tail.forEach((byte) => (code = (code << 6) | (byte & 0x3f)));
    text += code < 0x20 || code === 0x7f ? '·' : String.fromCodePoint(code);
    i += length;
  }
  return text;
}
