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
// ramp starts at 50 u/t so it cannot, and the first test below asserts
// it rather than trusting the arithmetic.
// ============================================================

import {
  engagement, closingBonus, DV_BONUS_MAX, DV_BONUS_START, DV_BONUS_FULL,
} from '../worker/transitCombat.js';

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
check('no bonus at the parting shot (26.5 u/t)', closingBonus(26.5) === 0,
  String(closingBonus(26.5)));
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

const fastOff = pass(211.5, 4, { dvBonusMax: 0 });
const fastOn = pass(211.5, 4);
// One tick in which the whole pass happens, so this is a single roll
// rather than the multi-tick total in transitExposure.mjs — the number
// is smaller there because the pass is spread across ticks. Both are
// honest; do not compare them directly.
check('a fast crossing is a poor shot on its own', fastOff.p < 0.10,
  `p=${fastOff.p.toFixed(4)}`);
// The precise claim, not a vague "it got better": the improvement is
// EXACTLY the ramp value at this speed. Anything else means the bonus
// is being scaled by something it should not touch (exposure, most
// likely), which is the bug this whole design was built to avoid.
check('...and the bonus adds exactly the ramp value, unscaled',
  near(fastOn.p - fastOff.p, closingBonus(211.5), 1e-9),
  `delta=${(fastOn.p - fastOff.p).toFixed(6)} ramp=${closingBonus(211.5).toFixed(6)}`);
check('...without ever exceeding the configured max',
  fastOn.p - fastOff.p <= DV_BONUS_MAX + 1e-9,
  `delta=${(fastOn.p - fastOff.p).toFixed(4)}`);

// A moon-hop is mid-ramp: it should get a little, not a lot.
const moonOff = pass(42.2, 4, { dvBonusMax: 0 });
const moonOn = pass(42.2, 4);
check('a moon-hop pass is below the ramp and unchanged',
  near(moonOff.p, moonOn.p), `${moonOff.p.toFixed(4)} -> ${moonOn.p.toFixed(4)}`);

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
const custom = pass(211.5, 4, { dvBonusMax: 0.3, dvBonusStart: 100, dvBonusFull: 200 });
check('a host can raise it', custom.bonus > DV_BONUS_MAX, String(custom.bonus));
check('a host can move the ramp', pass(120, 4, { dvBonusStart: 200 }).bonus === 0);

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
