// ============================================================
// How long do two ships actually shoot at each other in transit?
//
// Run: npm run sim:exposure
//
// WHY THIS EXISTS. A devlog draft claimed that ships whose paths cross
// "take one long-odds shot and it's over", and that a sustained fight
// required a deliberate matched-velocity rendezvous. A reader pushed
// back: on a shallow crossing, wouldn't they sit in range for several
// ticks trading volleys? They were right, and the draft was wrong.
//
// The mistake was reasoning from a PICTURE. On a map, "crossing" and
// "near-parallel" look like the same event at different angles. In the
// maths they are nothing alike, because time-in-range is chord divided
// by RELATIVE SPEED — and relative speed also sets the aim penalty, so
// the two effects compound. Between a fast crossing and a matched pair
// there is a wide, dangerous middle that neither label describes.
//
// This walks a pair tick by tick through closest approach using the
// real engagement functions, so any claim about "how long a transit
// fight lasts" can be checked instead of argued.
// ============================================================

import { exposure, crossingComponent, hitChance, V_REF, SHIP_RANGE }
  from '../worker/transitCombat.js';

const R = SHIP_RANGE.corvette;      // 12 in open space
const ATK = 0.85, DEF = 0.55;

/** Walk a pair whose relative velocity is `w` (units/tick) along a
 *  crossing geometry, starting far out and passing through closest
 *  approach `dMin`. Returns per-tick exposure + hit chance. */
function pass({ wMag, dMin, crossFrac, range = R, ticks = 12 }) {
  // Relative velocity split into the part along the line of sight and
  // the part across it. crossFrac = 1 is a pure beam pass; 0 is head-on.
  const wT = wMag * crossFrac;
  const wR = Math.sqrt(Math.max(0, wMag * wMag - wT * wT));
  const rows = [];
  // Start well before closest approach and step one tick at a time.
  const t0 = -(ticks / 2);
  for (let i = 0; i < ticks; i++) {
    const t = t0 + i;
    // Position along the pass at tick start, in a frame where the
    // separation is dMin at t = 0.
    const along = t * wMag;
    const r0 = { x: along, y: dMin };
    const w = { x: wMag, y: 0 };
    const f = exposure(r0, w, range);
    if (f <= 0) continue;
    const k = 1 + crossingComponent(r0, w) / V_REF;
    rows.push({ tick: t, f, p: hitChance(ATK, DEF, k, f) });
  }
  void wR;
  return rows;
}

const scenarios = [
  ['Interplanetary crossing (211 u/t)', { wMag: 211.5, dMin: 4, crossFrac: 1 }],
  ['Head-on at cruise (378 u/t)',       { wMag: 378,   dMin: 4, crossFrac: 0 }],
  ['Moon-hop beam pass (42 u/t)',       { wMag: 42.2,  dMin: 4, crossFrac: 1 }],
  ['Loose convoy (10 u/t apart)',       { wMag: 10,    dMin: 4, crossFrac: 0.5 }],
  ['Near-matched (4 u/t)',              { wMag: 4,     dMin: 4, crossFrac: 0.5 }],
  ['Matched (0.5 u/t drift)',           { wMag: 0.5,   dMin: 4, crossFrac: 0.5 }],
];

console.log('corvette range', R, 'units; ticks where it can fire at all\n');
for (const [label, cfg] of scenarios) {
  const rows = pass(cfg);
  const total = rows.reduce((a, r) => a + r.p, 0);
  console.log(label.padEnd(34),
    'ticks in range:', String(rows.length).padStart(2),
    ' exposure/tick:', rows.map(r => r.f.toFixed(2)).join(' ').padEnd(22),
    ' hit%:', rows.map(r => (r.p * 100).toFixed(1)).join(' ').padEnd(26),
    ' expected volleys landed:', total.toFixed(2));
}
