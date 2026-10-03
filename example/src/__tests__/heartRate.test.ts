import { parseHeartRateMeasurement } from '../lib/heartRate';

describe('Heart Rate Measurement', () => {
  it('reads an 8-bit value without extras (what the test peripheral sends)', () => {
    expect(parseHeartRateMeasurement(Uint8Array.of(0x00, 72))).toEqual({
      bpm: 72,
      sensorContact: null,
      energyExpendedKj: null,
      rrIntervalsMs: [],
    });
  });

  it('reads a 16-bit value, contact, energy and RR intervals', () => {
    // flags: 16-bit value, contact supported and detected, energy, RR intervals
    const value = Uint8Array.of(0x1f, 0x2c, 0x01, 0x10, 0x00, 0x00, 0x04, 0x00, 0x02);
    expect(parseHeartRateMeasurement(value)).toEqual({
      bpm: 300,
      sensorContact: true,
      energyExpendedKj: 16,
      rrIntervalsMs: [1000, 500],
    });
  });

  it('rejects values too short for their flags', () => {
    expect(parseHeartRateMeasurement(Uint8Array.of(0x00))).toBeNull();
    expect(parseHeartRateMeasurement(Uint8Array.of(0x01, 0x48))).toBeNull();
    expect(parseHeartRateMeasurement(Uint8Array.of(0x08, 72, 1))).toBeNull();
  });
});
