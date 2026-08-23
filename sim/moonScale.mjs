// ============================================================
// moonScale — spreading a planet's moons without breaking its system.
//
//   npm run sim:moonscale
//
// system_scale deliberately refused to touch moons, and its comment said
// why: "stretching them would push moons outside their parent's sphere
// of influence." That objection is the thing this sim exists to keep
// answered. SOI never positions a moon — position is parentPos +
// localPos — but it IS what decides whether a point counts as inside a
// planet system, which drives the transit-combat range cut, the fog and
// the labels. So the parent's SOI has to grow with its moons, and this
// asserts that it does at every scale a host can pick.
//
// Two other properties matter as much and are easier to lose:
//
//   PERIODS. A moon at 6x the radius keeping its old period orbits six
//   times faster in absolute terms. Transit combat scores hits off
//   closing speed, so that would quietly turn every station-keeping hull
//   into a hypersonic target. Periods scale r^1.5.
//
//   NEIGHBOURS. A moon system that reaches the next planet's orbit is a
//   map that looks fine and plays wrong — two systems overlapping means
//   "inside a planet system" stops naming one place.
// ============================================================

import {
  BODY_CATALOG, moonReachByParent, moonScaleCeiling, effectiveMoonScale, scaledGeometry,
} from '../worker/factions.js';

let bad = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`PASS  ${label}`); return; }
  bad += 1;
  console.log(`FAIL  ${label}`);
  if (detail) console.log(`        ${detail}`);
};

/** The catalogue as seedGameWorld would build it. Calls the SAME
 *  exported helpers the seeder does, so this measures the rule rather
 *  than a transcription of it — the failure mode that has bitten this
 *  codebase repeatedly is two copies of one rule drifting apart. */
function scaled(moonScaleWanted, sysScale = 1) {
  const moonReach = moonReachByParent();
  const moonScale = effectiveMoonScale(moonScaleWanted, sysScale);
  return BODY_CATALOG.map(b => ({
    ...b,
    ...scaledGeometry(b, { sysScale, bodyScale: 1, moonScale, moonReach }),
  }));
}

// Every pairing a host can enter, including deliberately absurd moon
// scales — the clamp is what must hold, not the operator's restraint.
const CASES = [
  [1, 1], [1, 2], [1, 8], [1, 50],
  [2, 4], [4, 8], [4, 20], [4, 200],
  [8, 8], [0.5, 4],
];

for (const [SYS, WANT] of CASES) {
  const M = `sys${SYS}/moon${WANT}`;
  const cat = scaled(WANT, SYS);
  const byId = new Map(cat.map(b => [b.id, b]));
  const moons = cat.filter(b => b.parent && b.parent !== 'sol');

  // ---- every moon stays inside its parent's sphere of influence ----
  const escaped = moons.filter((m) => {
    const p = byId.get(m.parent);
    return p && Number(p.soi) > 0 && m.orbit_radius > p.soi;
  });
  check(`${M}: every moon is inside its parent SOI`,
    escaped.length === 0,
    escaped.map(m => `${m.id} r=${Math.round(m.orbit_radius)} > ${m.parent} soi=${Math.round(byId.get(m.parent).soi)}`).join(' | '));

  // ---- a system must not reach the nearest body holding a slot ----
  // Rogue asteroids are excluded here for the same reason the clamp
  // excludes them: they cross orbits by design.
  const solid = cat
    .filter(b => b.parent === 'sol' && Number(b.orbit_radius) > 0 && b.type !== 'asteroid')
    .sort((a, b) => a.orbit_radius - b.orbit_radius);
  const overlaps = [];
  for (const p of solid) {
    const own = moons.filter(m => m.parent === p.id);
    if (own.length === 0) continue;
    const reach = Math.max(...own.map(m => m.orbit_radius));
    let nearest = Infinity;
    for (const o of solid) {
      if (o.id === p.id) continue;
      nearest = Math.min(nearest, Math.abs(o.orbit_radius - p.orbit_radius));
    }
    if (Number.isFinite(nearest) && reach >= nearest) {
      overlaps.push(`${p.id} reaches ${Math.round(reach)} into ${Math.round(nearest)}`);
    }
  }
  check(`${M}: no moon system reaches its nearest solid neighbour`,
    overlaps.length === 0, overlaps.join(' | '));
}

// ---- periods keep orbital speed SANE, not constant ----
{
  const one = scaled(1);
  const six = scaled(6, 4);
  const pick = (cat, id) => cat.find(b => b.id === id);
  const a = pick(one, 'europa');
  const b = pick(six, 'europa');
  // v = 2*pi*r / T. With r x6 and T x6^1.5, v scales 1/sqrt(6) — slower,
  // which is both physically right and the point of the exercise.
  const v1 = (2 * Math.PI * a.orbit_radius) / a.orbit_period;
  const v6 = (2 * Math.PI * b.orbit_radius) / b.orbit_period;
  const ratio = v6 / v1;
  check('a spread moon orbits SLOWER, not faster',
    ratio < 1, `speed ratio ${ratio.toFixed(3)}`);
  check('...by 1/sqrt(scale), which is Kepler',
    Math.abs(ratio - 1 / Math.sqrt(6)) < 0.001,
    `${ratio.toFixed(4)} vs ${(1 / Math.sqrt(6)).toFixed(4)}`);
}

// ---- the headline claim: travel time is sqrt(distance) ----
{
  const accel = 0.05 * 4 * 132.6;
  const trip = d => 2 * Math.sqrt(d / accel);
  const near = trip(20), far = trip(20 * 4);
  check('4x the distance is 2x the travel time, not 4x',
    Math.abs(far / near - 2) < 0.001, `ratio ${(far / near).toFixed(3)}`);
}

// ---- scale 1 changes nothing ----
{
  const one = scaled(1);
  const same = one.every((b) => {
    const src = BODY_CATALOG.find(x => x.id === b.id);
    return b.orbit_radius === src.orbit_radius
      && b.orbit_period === src.orbit_period
      && b.soi === src.soi;
  });
  check('moon_scale 1 leaves the shipped catalogue untouched', same);
}

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
