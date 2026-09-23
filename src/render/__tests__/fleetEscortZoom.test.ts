// [pure] An in-flight fleet folds into its flagship as you zoom out.
//
// QA battle test, 2026-09-22: the escort block had a fixed pixel floor,
// so a 60-hull fleet in flight stayed a dotted smear wider than Earth's
// orbit band at 0.06 and 0.012 while every parked garrison beside it had
// become one badge. The QA pass read the formation well from 2.5 down to
// 0.35, so it must be whole there and gone by the strategic zoom.

import { fleetEscortBlend, escortOffsets, escortSpacingFor } from '../fleetGrouping';

describe('[pure] fleetEscortBlend', () => {
  it('is whole across the zooms where the formation read well (2.5 .. 0.35)', () => {
    for (const s of [2.5, 1, 0.5, 0.35, 0.2]) expect(fleetEscortBlend(s)).toBe(1);
  });

  it('is gone at the zooms where it was a smear (0.06, 0.012)', () => {
    expect(fleetEscortBlend(0.06)).toBe(0);
    expect(fleetEscortBlend(0.012)).toBe(0);
  });

  it('fades monotonically in between, never popping', () => {
    let prev = 0;
    for (let s = 0.07; s <= 0.2; s *= 1.05) {
      const v = fleetEscortBlend(s);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
  });

  it('a 69-escort block at half fold is smaller than at full', () => {
    // The pass scales spacing by max(0.35, fold): the block contracts as
    // it fades rather than holding its full footprint while invisible.
    const extent = (fold: number) => {
      const spacing = escortSpacingFor(69, 12, 10) * Math.max(0.35, fold);
      const offs = escortOffsets(69, spacing, 0, 10 + spacing * 0.9);
      return Math.max(...offs.map(o => Math.hypot(o.dx, o.dy)));
    };
    expect(extent(fleetEscortBlend(0.1))).toBeLessThan(extent(1));
  });
});
