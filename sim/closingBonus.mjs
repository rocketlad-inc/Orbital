// ============================================================
// Closing-speed bonus — does it do the job, and does it stay in its lane?
//
// Run: npm run sim:closing
//
// WHY IT EXISTS. A fast pass was worth ~0.04 expected hits: nominally
// two ticks in range, actually 3-5% of each tick inside the envelope.
// Every aim-side knob moved that by hundredths, because expected damage
// is (ticks in range) x (chance per tick) and TIME was the binding
// constraint. The bonus pays for the short window directly.
//
// THE THING THIS FILE REALLY GUARDS. Orbital's combat matrix is tuned
// over roughly 990,000 battles, and DESIGN-combat-v2's numbers must
// reproduce EXACTLY at zero relative velocity — which is every fight
// that happens at a body, i.e. almost every fight in the game. A bonus
// that leaked into that would silently re-balance the whole game. The
// ramp starts above the parting shot (DV_BONUS_START, 21 u/t on today's
// burn) so it cannot, and the first tests below assert it rather than
// trusting the arithmetic.
// ============================================================

import {
  engagement, closingBonus, DV_BONUS_MAX, DV_BONUS_START, DV_BONUS_FULL,
} from '../worker/transitCombat.js';
import {
  fromG, LEGACY_ENGINE_G, SHIP_ENGINE_ACCEL, BRAKE_MUL, rampFor, burnShape,
  DEPARTURE_SPEED_SCALE,
} from '../worker/burn.js';

// The sample speeds below were measured on the legacy flat 0.05g even
// burn (2b0c7160). The burn has since become an exponential build with
// a 9x brake (77e00789, 0ee0774f) and the ramp moved with it. Carry each
// sample to today's burn the same way burn.js carries the thresholds:
// a departure by DEPARTURE_SPEED_SCALE, a cruise pass by re-flying the
// same route (d = v^2 / a on the even burn) and taking today's peak.
const LEGACY_ACCEL = fromG(LEGACY_ENGINE_G);
const cruiseNow = (legacyV) => {
  const { ramp, max, tau } = rampFor(SHIP_ENGINE_ACCEL);
  return burnShape(legacyV * legacyV / LEGACY_ACCEL, SHIP_ENGINE_ACCEL,
    ramp, max, BRAKE_MUL, tau).vPeak;
};
const PARTING_SHOT = 26.5 * DEPARTURE_SPEED_SCALE;  // ~11.0 u/t
const FAST_CROSSING = cruiseNow(211.5);              // ~275 u/t
const MOON_HOP = cruiseNow(42.2);                    // ~39 u/t

let bad = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`PASS  ${label}`); return; }
  bad += 1;
  console.log(`FAIL  ${label}`);
  if (detail) console.log(`        ${detail}`);
};

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ---------------------------------------------------------------
// 1. THE RAMP
// ---------------------------------------------------------------
check('no bonus at rest', closingBonus(0) === 0);
check('no bonus below the ramp', closingBonus(DV_BONUS_START - 0.001) === 0);
check(`no bonus at the parting shot (${PARTING_SHOT.toFixed(1)} u/t)`,
  closingBonus(PARTING_SHOT) === 0, String(closingBonus(PARTING_SHOT)));
check('half bonus at the ramp midpoint',
  near(closingBonus((DV_BONUS_START + DV_BONUS_FULL) / 2), DV_BONUS_MAX / 2),
  String(closingBonus((DV_BONUS_START + DV_BONUS_FULL) / 2)));
check('full bonus at the top of the ramp', near(closingBonus(DV_BONUS_FULL), DV_BONUS_MAX));
check('clamped above the ramp', near(closingBonus(10_000), DV_BONUS_MAX));
check('disabled by setting the max to 0', closingBonus(400, { dvBonusMax: 0 }) === 0);

// ---------------------------------------------------------------
// 2. THE INVARIANT — fights at a body must not move, at all
// ---------------------------------------------------------------
/** Two ships parked at the same body: identical segments, zero relative
 *  velocity. This is the geometry of nearly every fight in the game. */
const parked = (speedA, speedB) => engagement(
  { p0: { x: 0, y: 0 }, p1: { x: 0, y: 0 }, speed: speedA, shipClass: 'corvette' },
  { p0: { x: 2, y: 0 }, p1: { x: 2, y: 0 }, speed: speedB },
  {},
);
for (const [a, b, label] of [
  [0.85, 0.55, 'corvette vs freighter'],
  [0.85, 0.85, 'corvette vs corvette'],
  [0.65, 0.85, 'destroyer vs corvette'],
]) {
  const e = parked(a, b);
  check(`parked fight untouched — ${label} (bonus is exactly 0)`,
    e.bonus === 0, JSON.stringify({ bonus: e.bonus, p: e.p }));
}
// The canonical matrix value. At rest k = 1 and f = 1, so the whole
// formula collapses to atk^2 / (atk^2 + def^2) — 70.5% for a corvette
// shooting a freighter, exactly as DESIGN-combat-v2 has it. Derived
// rather than pasted: a hand-typed literal is how a "checked invariant"
// quietly becomes a check on somebody's arithmetic.
{
  const A = 0.85, D = 0.55;
  const expected = (A * A) / (A * A + D * D);
  check('...and the tuned number still lands where it always did',
    near(parked(A, D).p, expected), `${parked(A, D).p} vs ${expected}`);
}

// ---------------------------------------------------------------
// 3. IT ACTUALLY HELPS THE CASE IT WAS BUILT FOR
// ---------------------------------------------------------------
/** A crossing pass: attacker holds station, defender sweeps past at
 *  `speed` units this tick, missing by `dMin`. */
const pass = (dvPerTick, dMin, opts = {}) => engagement(
  { p0: { x: 0, y: 0 }, p1: { x: 0, y: 0 }, speed: 0.85, shipClass: 'corvette' },
  { p0: { x: -dvPerTick / 2, y: dMin }, p1: { x: dvPerTick / 2, y: dMin }, speed: 0.55 },
  opts,
);

const fastOff = pass(FAST_CROSSING, 4, { dvBonusMax: 0 });
const fastOn = pass(FAST_CROSSING, 4);
// One tick in which the whole pass happens, so this is a single roll
// rather than the multi-tick total in transitExposure.mjs — the number
// is smaller there because the pass is spread across ticks. Both are
// honest; do not compare them directly.
//
// Pinned to the corvette reach the bonus was designed at (12). Reach
// was doubled to 24 on purpose (95319bfc), which lifts this roll to
// ~0.11 — a design change, not this file's business. The claim here is
// about the shape of the maths, the same way transitCombat.test.ts pins
// its design-doc table to DESIGN_REACH.
const DESIGN_REACH = 12;
const fastDesign = pass(FAST_CROSSING, 4, { dvBonusMax: 0, range: DESIGN_REACH });
check('a fast crossing is a poor shot on its own (design reach)', fastDesign.p < 0.10,
  `p=${fastDesign.p.toFixed(4)}`);
// The precise claim, not a vague "it got better": the improvement is
// EXACTLY the ramp value at this speed. Anything else means the bonus
// is being scaled by something it should not touch (exposure, most
// likely), which is the bug this whole design was built to avoid.
check('...and the bonus adds exactly the ramp value, unscaled',
  near(fastOn.p - fastOff.p, closingBonus(FAST_CROSSING), 1e-9),
  `delta=${(fastOn.p - fastOff.p).toFixed(6)} ramp=${closingBonus(FAST_CROSSING).toFixed(6)}`);
check('...without ever exceeding the configured max',
  fastOn.p - fastOff.p <= DV_BONUS_MAX + 1e-9,
  `delta=${(fastOn.p - fastOff.p).toFixed(4)}`);

// A moon-hop. On the legacy burn it sat below the ramp (50 u/t) and got
// nothing; since the ramp moved down to the departure speed (21 u/t,
// 77e00789) it sits just inside it and gets a sliver (~+0.4%). It
// should get a little, not a lot, and exactly the ramp value.
const moonOff = pass(MOON_HOP, 4, { dvBonusMax: 0 });
const moonOn = pass(MOON_HOP, 4);
check('a moon-hop pass gets at most a sliver of the bonus',
  moonOn.p - moonOff.p < DV_BONUS_MAX / 10,
  `${moonOff.p.toFixed(4)} -> ${moonOn.p.toFixed(4)}`);
check('...and that sliver is exactly the ramp value',
  near(moonOn.p - moonOff.p, closingBonus(MOON_HOP), 1e-9),
  `delta=${(moonOn.p - moonOff.p).toFixed(6)} ramp=${closingBonus(MOON_HOP).toFixed(6)}`);

// ---------------------------------------------------------------
// 4. IT CANNOT PRODUCE NONSENSE
// ---------------------------------------------------------------
check('probability never exceeds 1', pass(400, 0, { dvBonusMax: 0.9 }).p <= 1);
check('out of range is still no engagement, bonus or not',
  pass(400, 500).engaged === false);
check('a blind shooter still gets nothing',
  pass(400, 4, { sees: false }).engaged === false);

// ---------------------------------------------------------------
// 5. HOST CONTROL
// ---------------------------------------------------------------
const custom = pass(FAST_CROSSING, 4, { dvBonusMax: 0.3, dvBonusStart: 100, dvBonusFull: 200 });
check('a host can raise it', custom.bonus > DV_BONUS_MAX, String(custom.bonus));
check('a host can move the ramp', pass(120, 4, { dvBonusStart: 200 }).bonus === 0);

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
