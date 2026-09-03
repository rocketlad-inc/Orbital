import {
  transitHullFit, TRANSIT_HULL_MIN_PX, TRANSIT_FITS_SLACK,
} from '../lod';

/**
 * Two complaints pulling in opposite directions, both from Lorne:
 *
 *  1. "a 28px ship on top of an 8px Callisto" — the sprite swamping the
 *     world it was heading for.
 *  2. "are you telling me we are no longer drawing ships in transit?" —
 *     the remedy for (1) had been to drop the sprite and count the hull
 *     into the destination's badge, which put ships on planets they had
 *     not reached.
 *
 * The clamp has to satisfy both: shrink, never disappear, never move.
 */
describe('transitHullFit', () => {
  const CORVETTE_PX = 28;

  it('leaves a hull alone when it already fits', () => {
    // Earth at 200px across, 28px corvette — no reason to touch it.
    expect(transitHullFit(1, CORVETTE_PX, 200)).toBe(1);
  });

  it('shrinks a corvette bound for an 8px Callisto — complaint (1)', () => {
    const scale = transitHullFit(1, CORVETTE_PX, 8);
    expect(scale).toBeLessThan(1);
    // Drawn width now fits the world instead of covering it.
    expect(CORVETTE_PX * scale).toBeLessThanOrEqual(8 * TRANSIT_FITS_SLACK);
  });

  it('never shrinks the hull out of existence — complaint (2)', () => {
    // A rock 0.2px across at strategic zoom. The old rule dropped the
    // ship here; the clamp keeps it visible.
    for (const dest of [0.2, 1, 2, 4]) {
      const scale = transitHullFit(1, CORVETTE_PX, dest);
      expect(scale).toBeGreaterThan(0);
      expect(CORVETTE_PX * scale).toBeGreaterThanOrEqual(TRANSIT_HULL_MIN_PX);
    }
  });

  it('never scales a hull UP to reach its destination size', () => {
    // Jupiter is enormous on screen; the hull keeps its own ramp.
    expect(transitHullFit(0.5, CORVETTE_PX, 4000)).toBe(0.5);
  });

  it('respects the zoom ramp it is handed as the ceiling', () => {
    // Already halved by zoom-out, and the destination has ample room:
    // the clamp must not undo the ramp.
    const base = 0.5;
    expect(transitHullFit(base, CORVETTE_PX, 100)).toBe(base);
    // And when it does bite, the result is never above the base.
    expect(transitHullFit(base, CORVETTE_PX, 3)).toBeLessThanOrEqual(base);
  });

  it('passes the base scale through when there is no destination', () => {
    // Deep space / no target body — nothing to compare against.
    expect(transitHullFit(0.8, CORVETTE_PX, null)).toBe(0.8);
    expect(transitHullFit(0.8, CORVETTE_PX, Infinity)).toBe(0.8);
    expect(transitHullFit(0.8, CORVETTE_PX, NaN)).toBe(0.8);
  });

  it('is monotonic — a smaller destination never yields a bigger hull', () => {
    let prev = Infinity;
    for (const dest of [200, 60, 28, 12, 8, 4, 1]) {
      const px = CORVETTE_PX * transitHullFit(1, CORVETTE_PX, dest);
      expect(px).toBeLessThanOrEqual(prev + 1e-9);
      prev = px;
    }
  });

  it('survives degenerate inputs without producing NaN', () => {
    for (const scale of [transitHullFit(0, CORVETTE_PX, 8),
      transitHullFit(1, 0, 8), transitHullFit(1, -5, 8)]) {
      expect(Number.isFinite(scale)).toBe(true);
    }
  });
});
