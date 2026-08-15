// ============================================================
// Balance levers for transit combat — what actually moves the needle?
//
// Run: npm run sim:levers
//
// THE QUESTION. A fast crossing lands ~0.04 hits. Is that a mechanic
// that costs a lot of effort to reach and then does nothing? If we want
// a floor under it, which knob buys the most, and what does each cost
// elsewhere?
//
// THE TRAP THIS ANSWERS. The instinct is to raise the hit chance —
// floor it, or soften the aim penalty. But expected damage is
// (ticks in range) x (hit chance per tick), and at 211 u/t a 12-unit
// envelope is crossed in about a tenth of a tick. TIME IN RANGE is the
// binding constraint, not the dice. A knob that only touches the dice
// runs into a ceiling of roughly "two ticks x one shot" no matter how
// generous it is — which is why the floor and the V_REF rows below
// barely move, and the range rows move a lot.
//
// Every number here comes from the real engagement functions.
// ============================================================

import { exposure, crossingComponent, hitChance, SHIP_RANGE } from '../worker/transitCombat.js';

const ATK = 0.85, DEF = 0.55;

/** Walk a pair through closest approach and total the expected hits.
 *  vRef and floor are injectable so a lever can be priced without
 *  editing the module under test. */
/** Lorne's proposal: high relative speed ADDS to the hit chance instead
 *  of only ever subtracting. The thematic argument is already in the
 *  model — something closing fast is boresighted, sitting still in the
 *  reticle and growing — so a snap shot at a fast mover is EASY to aim,
 *  it is just fleeting. This pays for the fleeting part.
 *
 *  Deliberately NOT scaled by exposure. Multiplying it by f would undo
 *  it exactly where it is meant to help: a contact you had 3% of a tick
 *  to shoot at would keep 3% of the bonus, which is no bonus at all. */
function dvBonus(wMag, { dvBonusMax = 0, dvBonusStart = 50, dvBonusFull = 350 } = {}) {
  if (dvBonusMax <= 0) return 0;
  const t = (wMag - dvBonusStart) / (dvBonusFull - dvBonusStart);
  return dvBonusMax * Math.max(0, Math.min(1, t));
}

function volleys({ wMag, dMin = 4, crossFrac = 1, range, vRef = 45, floor = 0.05,
                   absFloor = 0, ticks = 40, ...bonusOpts }) {
  let total = 0, inRange = 0;
  for (let i = 0; i < ticks; i++) {
    const t = i - ticks / 2;
    const r0 = { x: t * wMag, y: dMin };
    const w = { x: wMag * crossFrac, y: 0 };
    // Keep the magnitude honest when crossFrac < 1: the shortfall goes
    // into the closing component, which is what a shallow angle means.
    const wFull = { x: wMag * crossFrac, y: 0 };
    const f = exposure(r0, { x: wMag, y: 0 }, range);
    if (f <= 0) continue;
    inRange += 1;
    const k = 1 + (crossingComponent(r0, wFull) / vRef);
    let p = hitChance(ATK, DEF, k, f, floor);
    if (absFloor > 0) p = Math.max(p, absFloor);
    p = Math.min(1, p + dvBonus(wMag, bonusOpts));
    total += p;
  }
  return { inRange, total };
}

const CASES = [
  ['Crossing at cruise', { wMag: 211.5 }],
  ['Head-on at cruise', { wMag: 378, crossFrac: 0.05 }],
  ['Moon-hop beam pass', { wMag: 42.2 }],
  ['Loose convoy', { wMag: 10, crossFrac: 0.5 }],
];

const LEVERS = [
  ['baseline (range 12)', { range: 12 }],
  ['absolute floor 2% per tick', { range: 12, absFloor: 0.02 }],
  ['absolute floor 10% per tick', { range: 12, absFloor: 0.10 }],
  ['aim floor 0.05 -> 0.25', { range: 12, floor: 0.25 }],
  ['V_REF 45 -> 150 (softer aim penalty)', { range: 12, vRef: 150 }],
  ['V_REF 45 -> 400', { range: 12, vRef: 400 }],
  ['range 12 -> 40', { range: 40 }],
  ['range 12 -> 120', { range: 120 }],
  ['range 120 AND V_REF 150', { range: 120, vRef: 150 }],
  ['+10% closing-speed bonus', { range: 12, dvBonusMax: 0.10 }],
  ['+5% closing-speed bonus', { range: 12, dvBonusMax: 0.05 }],
  ['+20% closing-speed bonus', { range: 12, dvBonusMax: 0.20 }],
];

console.log('Expected hits landed over the whole pass (corvette 0.85 vs freighter 0.55)\n');
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('lever', 38) + CASES.map(c => pad(c[0], 21)).join(''));
for (const [label, opts] of LEVERS) {
  const cells = CASES.map(([, cfg]) => {
    const r = volleys({ ...cfg, ...opts });
    return pad(`${r.total.toFixed(2)}  (${r.inRange}t)`, 21);
  });
  console.log(pad(label, 38) + cells.join(''));
}

console.log('\nReading it: the floor and V_REF rows barely move the fast columns,');
console.log('because you are only inside the envelope for ~2 ticks. Range is the');
console.log('only lever that raises the ceiling — it buys TIME, which is the thing');
console.log('actually in short supply. It also inflates every slow case, which is');
console.log('the cost: a bigger envelope makes matched fights deadlier too.');
