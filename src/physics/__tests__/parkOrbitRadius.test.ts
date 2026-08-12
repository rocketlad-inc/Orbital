// [pure] Park orbit geometry.
//
// Guards the fix for "for such a small planet, ships are suppppper far out
// from the low orbit". The old rule was ADDITIVE (`radius + 2`) on a map
// whose bodies span radius 0.6 (Midas) to 20 (Sol), so the same offset was
// 4.3x the radius at the small end and 1.1x at the large end.
//
// Also guards the SYNC between the two copies of this rule: the client parks
// optimistically when a burn is committed, and the server confirms on
// arrival. If they ever disagree, every ship visibly jumps as it lands — so
// the worker's parkOrbitRadius (worker/factions.js) is reproduced here and
// asserted against the client's.

import { parkOrbitRadius } from '../orbitalMechanics';

/** Verbatim mirror of worker/factions.js parkOrbitRadius. */
function serverParkOrbitRadius(bodyRadius: number): number {
  const r = Number(bodyRadius) > 0 ? Number(bodyRadius) : 4;
  return Math.min(Math.max(r * 1.45 + 0.3, r + 0.35), r + 4);
}

// Real radii from the body catalog, smallest to largest.
const BODIES: Array<[string, number]> = [
  ['Midas', 0.6], ['Charon', 1.0], ['Enceladus', 1.0], ['Titan', 2.0],
  ['Mars', 2.5], ['Saturn', 7.0], ['Jupiter', 8.0], ['Sol', 20.0],
];

describe('[pure] parkOrbitRadius', () => {
  it('never disagrees with the server copy', () => {
    for (const [, r] of BODIES) {
      expect(parkOrbitRadius(r)).toBeCloseTo(serverParkOrbitRadius(r), 10);
    }
    // Including the degenerate inputs both sides guard.
    for (const r of [0, -1, NaN]) {
      expect(parkOrbitRadius(r)).toBeCloseTo(serverParkOrbitRadius(r), 10);
    }
  });

  it('keeps every body in a consistent altitude band', () => {
    // The whole point: "low orbit" must mean the same thing on a pebble and
    // on the sun. Old rule spanned 1.1x-4.3x; this must stay tight.
    const ratios = BODIES.map(([, r]) => parkOrbitRadius(r) / r);
    expect(Math.min(...ratios)).toBeGreaterThan(1.15);
    expect(Math.max(...ratios)).toBeLessThan(2.0);
  });

  it('pulls small bodies IN versus the old additive rule', () => {
    // Midas is the worst case on the map and the one that was reported.
    expect(parkOrbitRadius(0.6)).toBeLessThan(0.6 + 2);
    expect(parkOrbitRadius(1.0)).toBeLessThan(1.0 + 2);
    // ~55% closer at Midas.
    expect(parkOrbitRadius(0.6) / (0.6 + 2)).toBeLessThan(0.5);
  });

  it('leaves the big bodies roughly where they were', () => {
    // The clamp exists so framing that already reads well is not disturbed.
    // Sol: 22 before, and the clamp holds it to 24 rather than 29.3.
    expect(parkOrbitRadius(20)).toBeCloseTo(24, 6);
    expect(parkOrbitRadius(7) / (7 + 2)).toBeLessThan(1.25);
    expect(parkOrbitRadius(8) / (8 + 2)).toBeLessThan(1.25);
  });

  it('the +4 ceiling binds only for the very largest bodies', () => {
    // r*1.45 + 0.3 > r + 4  <=>  r > ~8.22
    expect(parkOrbitRadius(8)).toBeCloseTo(8 * 1.45 + 0.3, 6);   // unclamped
    expect(parkOrbitRadius(20)).toBeCloseTo(20 + 4, 6);          // clamped
  });

  it('keeps a visible gap over a pebble', () => {
    // Floor: never sits on the surface, however tiny the rock.
    for (const r of [0.1, 0.3, 0.5]) {
      expect(parkOrbitRadius(r) - r).toBeGreaterThanOrEqual(0.35 - 1e-9);
    }
  });

  it('is monotonic in body radius', () => {
    // A bigger body must never give a tighter orbit — that would read as a
    // rendering glitch and break the mental model.
    const rs = [0.1, 0.6, 1, 2, 5, 8, 8.5, 12, 20, 40];
    for (let i = 1; i < rs.length; i++) {
      expect(parkOrbitRadius(rs[i])).toBeGreaterThan(parkOrbitRadius(rs[i - 1]));
    }
  });
});
