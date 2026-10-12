// Base64 for the ble-plx compatibility layer: the only place it exists (Appendix B rule 6).

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VALUES = new Map([...ALPHABET].map((char, index) => [char, index]));

/** Standard base64 with padding, as ble-plx hands values out. */
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const triple = (a << 16) | (b << 8) | c;
    out += ALPHABET[(triple >> 18) & 63] + ALPHABET[(triple >> 12) & 63];
    out += i + 1 < bytes.length ? ALPHABET[(triple >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? ALPHABET[triple & 63] : '=';
  }
  return out;
}

/** The bytes of `value`, padding optional; null when it isn't base64. */
export function fromBase64(value: unknown): Uint8Array | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/=+$/, '');
  if (text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let buffer = 0;
  let index = 0;
  for (const char of text) {
    const sextet = VALUES.get(char);
    if (sextet === undefined) return null;
    buffer = (buffer << 6) | sextet;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (buffer >> bits) & 0xff;
    }
  }
  return out;
}
