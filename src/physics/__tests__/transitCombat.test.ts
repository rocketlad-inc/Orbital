// [pure] Transit combat arithmetic (DESIGN-transit-combat.md R2/R3).
//
// Every function under test is a pure function of numbers, and every
// expected value below was derived independently in the design review —
// the hit matrix from DESIGN-combat-v2.md, the scenario table from the
// worked examples at the live game's engine_g. If one of these moves,
// the balance moved, not the test.
//
// The single most important case here is the t* degeneracy test: it
// asserts the WRONG evaluation point gives the WRONG answer. The
// crossing decomposition only means anything at tick start; at closest
// approach r ⊥ w by definition and the split silently collapses back
// into the total-relative-speed model it replaced. A refactor that
// "tidies" the evaluation point will fail that test and nothing else,
// with every production number still looking plausible.

import {
  closestApproach,
  crossingComponent,
  aimFactor,
  exposure,
  hitChance,
  engagement,
  V_REF,
  AIM_FLOOR,
  SHIP_RANGE,
  // Jest in this repo transpiles plain-JS imports from worker/ fine —
  // this is the same module the tick will call, not a mirror.
} from '../../../worker/transitCombat.js';

const P = (x: number, y: number) => ({ x, y });

// Speeds from SHIP_COMBAT_STATS (worker/factions.js), the v2 tuning.
const CORVETTE = 0.85;
const FRIGATE = 0.50;
const DESTROYER = 0.30;
const FREIGHTER = 0.55;

describe('[pure] closestApproach', () => {
  it('co-located parked pair: dMin 0, dv 0', () => {
    const r = closestApproach(P(5, 5), P(5, 5), P(5, 5), P(5, 5));
    expect(r.dMin).toBe(0);
    expect(r.dv).toBe(0);
  });

  it('parallel identical velocity (w·w = 0): separation constant, tStar 0', () => {
    const r = closestApproach(P(0, 0), P(10, 0), P(0, 3), P(10, 3));
    expect(r.dMin).toBe(3);
    expect(r.tStar).toBe(0);
  });

  it('head-on crossing INSIDE one tick — the case naive per-tick sampling misses', () => {
    // A parked at origin; B sweeps from (-50,1) to (50,1). At any tick
    // boundary B is 50 units away; at t*=0.5 it passes 1 unit away.
    const r = closestApproach(P(0, 0), P(0, 0), P(-50, 1), P(50, 1));
    expect(r.dMin).toBeCloseTo(1, 9);
    expect(r.tStar).toBeCloseTo(0.5, 9);
  });

  it('receding target clamps tStar to 0', () => {
    const r = closestApproach(P(0, 0), P(0, 0), P(10, 0), P(30, 0));
    expect(r.tStar).toBe(0);
    expect(r.dMin).toBe(10);
  });

  it('approaching target whose closest point is next tick clamps tStar to 1', () => {
    const r = closestApproach(P(0, 0), P(0, 0), P(100, 0), P(60, 0));
    expect(r.tStar).toBe(1);
    expect(r.dMin).toBe(60);
  });
});

describe('[pure] crossingComponent — evaluated at tick start, never at t*', () => {
  it('purely radial motion: w_t = 0 (boresighted)', () => {
    expect(crossingComponent(P(100, 0), P(-40, 0))).toBe(0);
  });

  it('purely tangential motion: w_t = |w|', () => {
    expect(crossingComponent(P(100, 0), P(0, 40))).toBe(40);
  });

  it('45°: w_t = |w|/√2', () => {
    expect(crossingComponent(P(100, 0), P(-30, 30))).toBeCloseTo(30, 9);
  });

  it('co-located (the parting shot): radial by construction, w_t = 0', () => {
    expect(crossingComponent(P(0, 0), P(26.5, 0))).toBe(0);
  });

  it('THE TRAP: at unclamped t* the decomposition degenerates to |w|', () => {
    // r0=(20,0), w=(-40,10): t* = 800/1700 ≈ 0.47, inside the tick, so
    // r(t*)·w = 0 exactly — everything reads as crossing there.
    const r0 = P(20, 0);
    const w = P(-40, 10);
    const ww = w.x * w.x + w.y * w.y;
    const tS = -(r0.x * w.x + r0.y * w.y) / ww;
    expect(tS).toBeGreaterThan(0);
    expect(tS).toBeLessThan(1);
    const rAtT = P(r0.x + tS * w.x, r0.y + tS * w.y);
    expect(rAtT.x * w.x + rAtT.y * w.y).toBeCloseTo(0, 9); // perpendicular
    const wLen = Math.hypot(w.x, w.y);
    // Evaluated at t*: the split returns |w| — i.e. the OLD model.
    expect(crossingComponent(rAtT, w)).toBeCloseTo(wLen, 6);
    // Evaluated at tick start: the real crossing signal survives.
    expect(crossingComponent(r0, w)).toBeCloseTo(10, 6);
    // If the first assertion ever FAILS, someone moved the production
    // evaluation point to t* and "fixed" this test to match. Revert.
  });
});

describe('[pure] aimFactor', () => {
  it('w_t = 0 → k = 1 (no penalty at rest or matched)', () => {
    expect(aimFactor(0)).toBe(1);
  });
  it('w_t = V_REF → k = 2', () => {
    expect(aimFactor(V_REF)).toBe(2);
  });
});

describe('[pure] exposure — the overlap of the segment with the envelope', () => {
  // Solved exactly rather than as chord/speed. The shortcut assumes the
  // target ENTERS and EXITS; the cases below are the ones where it
  // doesn't, and they are not exotic — the first one is every ship that
  // ever fled a body someone was parked at.
  it('relative rest inside range: f = 1, no divide-by-zero', () => {
    expect(exposure(P(3, 0), P(0, 0), 12)).toBe(1);
  });
  it('relative rest outside range: f = 0', () => {
    expect(exposure(P(50, 0), P(0, 0), 12)).toBe(0);
  });
  it('unarmed hull (range 0): f = 0', () => {
    expect(exposure(P(1, 0), P(10, 0), 0)).toBe(0);
  });
  it('LAUNCHING FROM THE CENTRE traverses only the outbound half', () => {
    // The regression that caught the chord formula: it answered 1.00
    // ("never left"), turning the design's 63.8% parting shot into a
    // free 70.5% point-blank one.
    expect(exposure(P(0, 0), P(13.26, 0), 12)).toBeCloseTo(12 / 13.26, 9);
  });
  it('a clean pass-through DOES match chord/speed', () => {
    expect(exposure(P(-100, 0), P(200, 0), 12)).toBeCloseTo(24 / 200, 9);
  });
  it('a pass that ends inside counts only the part flown', () => {
    expect(exposure(P(-20, 0), P(12, 0), 12)).toBeCloseTo((12 - 8) / 12, 9);
  });
  it('a miss is 0', () => {
    expect(exposure(P(0, 50), P(200, 0), 12)).toBe(0);
  });
  it("a destroyer's window is 20/12 of a corvette's — range buys time, not just permission", () => {
    const r0 = P(-100, 0), w = P(200, 0);
    expect(exposure(r0, w, SHIP_RANGE.destroyer) / exposure(r0, w, SHIP_RANGE.corvette))
      .toBeCloseTo(20 / 12, 9);
  });
});

describe('[pure] hitChance reproduces the DESIGN-combat-v2 matrix at k=1, f=1', () => {
  // The invariant the whole design hangs on: every fight that happens in
  // the game today is numerically untouched.
  const cases: Array<[string, number, number, number]> = [
    ['corvette→corvette', CORVETTE, CORVETTE, 50.0],
    ['corvette→frigate', CORVETTE, FRIGATE, 74.3],
    ['corvette→destroyer', CORVETTE, DESTROYER, 88.9],
    ['frigate→corvette', FRIGATE, CORVETTE, 25.7],
    ['frigate→frigate', FRIGATE, FRIGATE, 50.0],
    ['frigate→destroyer', FRIGATE, DESTROYER, 73.5],
    ['destroyer→corvette', DESTROYER, CORVETTE, 11.1],
    ['destroyer→frigate', DESTROYER, FRIGATE, 26.5],
    ['destroyer→destroyer', DESTROYER, DESTROYER, 50.0],
  ];
  it.each(cases)('%s = %f%%', (_label: string, atk: number, def: number, pct: number) => {
    expect(100 * hitChance(atk, def, 1, 1)).toBeCloseTo(pct, 1);
  });
});

describe('[pure] the 5% floor', () => {
  it('applies to the AIM term, then exposure scales it', () => {
    // destroyer→corvette at cruise: aimed ≈ 0.4% floors to 5%, then f=0.18
    expect(hitChance(DESTROYER, CORVETTE, 5.70, 0.18)).toBeCloseTo(AIM_FLOOR * 0.18, 9);
  });
  it('never lifts a well-aimed but brief shot to a flat 5%', () => {
    const aimed = (CORVETTE * CORVETTE) / (CORVETTE * CORVETTE + FREIGHTER * FREIGHTER);
    expect(hitChance(CORVETTE, FREIGHTER, 1, 0.06)).toBeCloseTo(aimed * 0.06, 9);
  });
});

describe('[pure] the design-doc scenario table (corvette → freighter)', () => {
  // Derived at engine_g 0.05 → 26.52 units/tick² in the 2026-08-14 review.
  const scenario = (wT: number, r0: {x:number;y:number}, w: {x:number;y:number}) =>
    100 * hitChance(CORVETTE, FREIGHTER, aimFactor(wT), exposure(r0, w, SHIP_RANGE.corvette));

  it('parked / matched formation: 70.5% — unchanged from today', () => {
    expect(scenario(0, P(3, 0), P(0, 0))).toBeCloseTo(70.5, 1);
  });
  it('parting shot (launch from the shooter body, one tick of burn): 63.8%', () => {
    // 13.26 units covered in the first tick at engine_g 0.05.
    expect(scenario(0, P(0, 0), P(13.26, 0))).toBeCloseTo(63.8, 1);
  });
  it('beam pass at moon-hop peak is much harder than the old model said', () => {
    const p = scenario(42.2, P(0, 6), P(42.2, 0));
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(38.9);   // the superseded |w|-only number
  });
  it('head-on at cruise: perfect aim, almost no window', () => {
    const p = scenario(0, P(-200, 0), P(378, 0));
    expect(p).toBeLessThan(10);
  });
  it('a crossing at cruise is harder than a head-on at cruise', () => {
    expect(scenario(211.5, P(0, 6), P(211.5, 0)))
      .toBeLessThan(scenario(0, P(-200, 0), P(378, 0)));
  });
});

describe('[pure] stern-chase symmetry', () => {
  // Who is in front is a statement about the star, not a physical fact.
  // Rear→front and front→rear are identical, and both equal the parked
  // case at the same separation. If someone "fixes" this by penalising
  // the pursuer, revert — see the design doc's chase section.
  const a = { p0: P(0, 0), p1: P(200, 0), speed: CORVETTE, shipClass: 'corvette' };
  const b = { p0: P(8, 0), p1: P(208, 0), speed: CORVETTE, shipClass: 'corvette' };

  it('rear→front == front→rear', () => {
    expect(engagement(a, b).p).toBe(engagement(b, a).p);
  });
  it('matched chase == parked at the same separation', () => {
    const pa = { p0: P(0, 0), p1: P(0, 0), speed: CORVETTE, shipClass: 'corvette' };
    const pb = { p0: P(8, 0), p1: P(8, 0), speed: CORVETTE, shipClass: 'corvette' };
    expect(engagement(a, b).p).toBeCloseTo(engagement(pa, pb).p, 9);
  });
});

describe('[pure] engagement gates', () => {
  const shooter = { p0: P(0, 0), p1: P(0, 0), speed: CORVETTE, shipClass: 'corvette' };

  it('out of range: no engagement', () => {
    const far = { p0: P(50, 0), p1: P(50, 0), speed: FREIGHTER, shipClass: 'freighter' };
    expect(engagement(shooter, far).engaged).toBe(false);
  });
  it('no line of sight (R4): no engagement, no roll, nothing to leak', () => {
    const near = { p0: P(5, 0), p1: P(5, 0), speed: FREIGHTER, shipClass: 'freighter' };
    expect(engagement(shooter, near, { sees: false }).engaged).toBe(false);
  });
  it('unarmed hulls never initiate', () => {
    const freighter = { p0: P(5, 0), p1: P(5, 0), speed: FREIGHTER, shipClass: 'freighter' };
    expect(engagement(freighter, shooter).engaged).toBe(false);
  });
  it('REGRESSION (the bug that started all this): a hull still at body A deals zero to a ship long departed', () => {
    // The old failure: parent_body_id kept pointing at A during flight,
    // so hulls at A shot a ship 300 units away. With real positions the
    // pair is simply out of range.
    const fled = { p0: P(300, 0), p1: P(340, 0), speed: FREIGHTER, shipClass: 'freighter' };
    expect(engagement(shooter, fled).engaged).toBe(false);
  });
});
