// The Heart Rate Measurement characteristic (0x2A37), as the Bluetooth Heart Rate Service
// specification lays it out: a flags byte, then the fields the flags announce.

export interface HeartRateMeasurement {
  bpm: number;
  /** Whether the strap touches the skin; null when the strap can't tell. */
  sensorContact: boolean | null;
  /** Energy expended in kJ, when sent. */
  energyExpendedKj: number | null;
  /** Time between beats, in milliseconds. */
  rrIntervalsMs: number[];
}

/** Null when the value is too short for its flags. */
export function parseHeartRateMeasurement(value: Uint8Array): HeartRateMeasurement | null {
  if (value.length < 2) return null;
  const flags = value[0];
  const wide = (flags & 0x01) !== 0;
  const contactSupported = (flags & 0x04) !== 0;
  const hasEnergy = (flags & 0x08) !== 0;
  const hasRr = (flags & 0x10) !== 0;
  const u16 = (at: number) => value[at] | (value[at + 1] << 8);

  let offset = 1;
  if (value.length < offset + (wide ? 2 : 1)) return null;
  const bpm = wide ? u16(offset) : value[offset];
  offset += wide ? 2 : 1;

  let energyExpendedKj: number | null = null;
  if (hasEnergy) {
    if (value.length < offset + 2) return null;
    energyExpendedKj = u16(offset);
    offset += 2;
  }
  const rrIntervalsMs: number[] = [];
  if (hasRr) {
    for (; offset + 1 < value.length; offset += 2) {
      rrIntervalsMs.push(Math.round((u16(offset) * 1000) / 1024)); // units of 1/1024 s
    }
  }
  return {
    bpm,
    sensorContact: contactSupported ? (flags & 0x02) !== 0 : null,
    energyExpendedKj,
    rrIntervalsMs,
  };
}
