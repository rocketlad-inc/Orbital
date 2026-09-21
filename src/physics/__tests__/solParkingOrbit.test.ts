// ============================================================
// HULLS PARKED AT THE SUN ORBIT IT.
//
// Reported from a screenshot of 69 Tritalowda hulls ringing Sol: "they
// are not animating their orbit like they are supposed to." Every hull
// parked at a planet circles it; the ones at Sol sat frozen.
//
// Sol is seeded with mu = 0 (planets orbit it by orbit_period, so the
// server never needed its μ). The multiplayer mapper took that column
// at its word, Kepler's third law gave period 0, and trueAnomalyAt's
// "no gravity, no motion" guard parked every hull at a fixed angle.
// ============================================================

import {
  parentMuForParking, trueAnomalyAt, GRAVITATIONAL_PARAMS,
} from '../orbitalMechanics';

/** Exactly the Sol row the live /state sends: mu 0, a star. The client
 *  mapper turns 0 into undefined (`b.mu || undefined`), so both. */
const SOL_ZERO = { mu: 0, type: 'star' };
const SOL_UNDEF = { mu: undefined, type: 'star' };
const EARTH = { mu: 100, type: 'terrestrial' };

/** The mapper's own period formula (shipToClient). */
const periodAt = (mu: number, a: number) =>
  (mu > 0 ? 2 * Math.PI * Math.sqrt((a * a * a) / mu) : 0);

describe('parking orbit at a star', () => {
  it('a star seeded without μ still gets the solar μ', () => {
    expect(parentMuForParking(SOL_ZERO)).toBe(GRAVITATIONAL_PARAMS.SOL);
    expect(parentMuForParking(SOL_UNDEF)).toBe(GRAVITATIONAL_PARAMS.SOL);
    expect(parentMuForParking({ mu: 0, type: 'black_hole' })).toBe(GRAVITATIONAL_PARAMS.SOL);
  });

  it('every other body keeps the μ it was given, and nothing stays nothing', () => {
    expect(parentMuForParking(EARTH)).toBe(100);
    expect(parentMuForParking(null)).toBe(0);            // in transit: no parent
    expect(parentMuForParking({ mu: 0, type: 'megastructure' })).toBe(0);
  });

  it('a hull at the live Sol parking radius actually moves', () => {
    // orbit_rp = orbit_ra = 130 on every live Sol hull.
    const period = periodAt(parentMuForParking(SOL_ZERO), 130);
    expect(period).toBeGreaterThan(0);
    const orbit = { rp: 130, ra: 130, M0: 1.1865, epoch: 566, period, omega: 0, direction: 1 };
    const a0 = trueAnomalyAt(orbit as never, 600);
    const a1 = trueAnomalyAt(orbit as never, 601);
    expect(Math.abs(a1 - a0)).toBeGreaterThan(1e-3);
  });

  it('...at a pace in the same league as a planet park, not a blur or a crawl', () => {
    // Earth: a launched/parked hull sits at rp 18 / ra 20.
    const earth = periodAt(parentMuForParking(EARTH), 19);
    const sol = periodAt(parentMuForParking(SOL_ZERO), 130);
    expect(sol / earth).toBeGreaterThan(1);    // a bigger orbit is slower
    expect(sol / earth).toBeLessThan(10);      // but it visibly turns
  });
});
