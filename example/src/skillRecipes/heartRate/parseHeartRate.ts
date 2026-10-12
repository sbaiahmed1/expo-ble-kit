export type HeartRate = {
  bpm: number;
  /** null when the strap doesn't report skin contact. */
  contact: boolean | null;
  energyKj: number | null;
  /** Beat-to-beat intervals in milliseconds. */
  rrMs: number[];
};

export function parseHeartRate(value: Uint8Array): HeartRate {
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const flags = view.getUint8(0);
  let offset = 1;
  const wide = (flags & 0x01) !== 0;
  const bpm = wide ? view.getUint16(offset, true) : view.getUint8(offset);
  offset += wide ? 2 : 1;
  const contactBits = (flags >> 1) & 0x03;
  const contact = contactBits & 0x02 ? contactBits === 0x03 : null;
  let energyKj: number | null = null;
  if (flags & 0x08) {
    energyKj = view.getUint16(offset, true);
    offset += 2;
  }
  const rrMs: number[] = [];
  if (flags & 0x10) {
    for (; offset + 1 < value.byteLength; offset += 2) {
      rrMs.push(Math.round((view.getUint16(offset, true) * 1000) / 1024));
    }
  }
  return { bpm, contact, energyKj, rrMs };
}
