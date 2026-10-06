// The kinetic burst grows with the hull (Lorne, 2026-10-06): one round
// for a corvette, two for a frigate, three for a destroyer. The look only
// -- the server's volley and its damage are untouched.

import { FX_TUNING, kineticRoundsOf, burstSlots } from '../fxTuning';

describe('kinetic burst size by hull', () => {
  it('a corvette fires one round, a frigate two, a destroyer three', () => {
    expect(kineticRoundsOf('corvette')).toBe(1);
    expect(kineticRoundsOf('frigate')).toBe(2);
    expect(kineticRoundsOf('destroyer')).toBe(3);
  });

  it('stations, capital hulls and anything unknown keep the full burst', () => {
    expect(kineticRoundsOf(undefined)).toBe(3);
    expect(kineticRoundsOf('mega_destroyer')).toBe(3);
    expect(kineticRoundsOf('something_new')).toBe(3);
  });

  it('a three-round burst keeps the timing it always had', () => {
    const b = burstSlots(3);
    expect(b).toEqual({ first: 0, slots: 3, flight: FX_TUNING.boltMs - 2 * FX_TUNING.roundGapMs });
  });

  it('every round flies at the same speed, and the last lands with the big hit', () => {
    for (const n of [1, 2, 3]) {
      const { first, slots, flight } = burstSlots(n);
      expect(slots - first).toBe(n);
      expect(flight).toBe(burstSlots(3).flight);
      // The final round leaves at (slots - 1) * gap and lands at boltMs.
      expect((slots - 1) * FX_TUNING.roundGapMs + flight).toBe(FX_TUNING.boltMs);
    }
  });

  it('a bigger burst still lands its last round on the big hit', () => {
    const { first, slots, flight } = burstSlots(5);
    expect(slots - first).toBe(5);
    expect((slots - 1) * FX_TUNING.roundGapMs + flight).toBe(FX_TUNING.boltMs);
  });
});
