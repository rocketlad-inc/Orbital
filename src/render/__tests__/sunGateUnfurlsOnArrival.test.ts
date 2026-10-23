/**
 * A SUN GATE OPENS ON ITS LANDING SITE (Studio clip a-sun-gate-is-born,
 * 7.7-8.1 s, f232-f242).
 *
 * The Centauri gate flies 6,671 units (Sun's surface to a 6,721 orbit) in
 * six ticks on an even push-flip-brake: at the clip's zoom (2.6 px/unit)
 * that is ~17,000 px. Its unfurling was keyed to the last fifth of the
 * flight's TIME, and the last few percent of that time is still hundreds
 * of px of flight: the ring finished 100-220 px short of the gold reticle,
 * which then slid into the open gate and sat over its eye.
 */
import { sunGateMorph, sunGateArrivalMorph, SUN_GATE_UNFURL_RINGS } from '../sunSquid';
import { siteCoveredByGate } from '../mapRenderer';

const D = (6721 - 50) * 2.6;           // px, the flight on screen
const ringR = 40;                       // px, about the clip's ring
/** Drawn gap to the site at flight fraction f (bodyPosition's profile). */
const gapAt = (f: number, d = D) => d * (f <= 0.5 ? 1 - 2 * f * f : 2 * (1 - f) * (1 - f));

describe('the unfurling', () => {
  it('the clock alone finished the ring well short of the site (the bug, measured)', () => {
    let f = 0.8;
    while (sunGateMorph(f) < 0.75) f += 0.001;
    expect(gapAt(f)).toBeGreaterThan(100);
  });

  it('is whole only on arrival: never three-quarters unfurled more than a ring radius out', () => {
    for (let f = 0; f <= 1; f += 0.0005) {
      if (sunGateArrivalMorph(f, gapAt(f), ringR) >= 0.75) {
        expect(gapAt(f)).toBeLessThanOrEqual(ringR + 0.5);
      }
    }
    expect(sunGateArrivalMorph(1, 0, ringR)).toBe(1);
  });

  it('still visibly unfurls on the way in (starts a few ring radii out)', () => {
    let f = 0.5;
    while (sunGateArrivalMorph(f, gapAt(f), ringR) <= 0) f += 0.0005;
    expect(gapAt(f)).toBeGreaterThan(0.9 * SUN_GATE_UNFURL_RINGS * ringR);
    expect(gapAt(f)).toBeLessThanOrEqual(SUN_GATE_UNFURL_RINGS * ringR + 1);
  });

  it('a short hop keeps the clock rule (no unfurling before the flip)', () => {
    const d = 150;
    for (const f of [0.3, 0.5, 0.7]) expect(sunGateArrivalMorph(f, gapAt(f, d), ringR)).toBe(0);
    expect(sunGateArrivalMorph(0.9, gapAt(0.9, d), ringR)).toBeLessThanOrEqual(sunGateMorph(0.9));
  });
});

describe('the reticle', () => {
  it('goes under the gate once the gate is within its art radius', () => {
    expect(siteCoveredByGate(120, 46, false)).toBe(false);
    expect(siteCoveredByGate(40, 46, false)).toBe(true);
    expect(siteCoveredByGate(500, 46, true)).toBe(true);
  });
});
