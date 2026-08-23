// ============================================================
// megaPlacement — parking a megastructure where the player clicked.
//
//   npm run sim:megaplacement
//
// Placement is the only genuinely new machinery in the megastructure
// system, and it is the kind of maths that looks right and is wrong.
// Three ways it can be wrong, all of which read as a bug to a player
// however defensible the code is:
//
//   IT APPEARS SOMEWHERE ELSE. angle0 is a position at epoch zero, not
//   a position now. Store the clicked angle directly and the foundation
//   lands wherever the orbit had wound to by the current tick — which,
//   on a fast inner orbit hundreds of ticks in, is anywhere at all.
//
//   IT DRIFTS AGAINST ITS NEIGHBOURS. Periods in the database have been
//   through system_scale, moon_scale and outer_orbit_speedup. A period
//   computed from the mu column ignores all three, so a site would slide
//   against the very moons it was parked among.
//
//   IT PICKS THE WRONG PARENT. Every point inside Io's SOI is inside
//   Jupiter's as well. The specific answer is the moon.
// ============================================================

import {
  deriveSiteOrbit, soiHolderAt, periodForRadius, bodyPositionAt,
  applyCapture, progressOf, isComplete, remainingFor,
  CAPTURE_PROGRESS_KEPT, MEGASTRUCTURES, MEGASTRUCTURE_KINDS,
} from '../worker/megastructures.js';
import { BODY_CATALOG, scaledGeometry, moonReachByParent } from '../worker/factions.js';

let bad = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`PASS  ${label}`); return; }
  bad += 1;
  console.log(`FAIL  ${label}`);
  if (detail) console.log(`        ${detail}`);
};

// A board built exactly the way the seeder builds one, at the settings
// staging is actually running: spread 4x with moons spread 8x. Using the
// real geometry matters — the failure modes above only appear once the
// scale knobs have been through the catalogue.
const SYS = 4, MOON = 8;
const moonReach = moonReachByParent();
const BODIES = BODY_CATALOG.map(b => ({
  id: b.id,
  type: b.type,
  parent_body_id: b.parent === 'sol' || !b.parent ? (b.id === 'sol' ? null : 'sol') : b.parent,
  mu: b.mu,
  ...scaledGeometry(b, { sysScale: SYS, bodyScale: 1, moonScale: MOON, moonReach }),
}));
const byId = new Map(BODIES.map(b => [b.id, b]));
const at = (id, tick) => bodyPositionAt(byId.get(id), byId, tick);

// ---- a site appears where it was clicked -----------------------------
{
  // Every tick here is a real one a game could be at. 0 is the easy
  // case; 137 and 4001 are where a mishandled angle0 goes wrong.
  for (const tick of [0, 137, 4001]) {
    for (const [label, anchor, off] of [
      ['deep space', 'sol', { x: 9000, y: -4000 }],
      ['near Earth', 'earth', { x: 60, y: 40 }],
      ['among Jupiter’s moons', 'jupiter', { x: 300, y: -180 }],
    ]) {
      const base = at(anchor, tick);
      const point = { x: base.x + off.x, y: base.y + off.y };
      const orbit = deriveSiteOrbit(point, BODIES, tick);
      if (!orbit) { check(`t${tick} ${label}: derived an orbit`, false); continue; }
      // Re-place the derived site into the world and ask where it is.
      const site = { id: 'site', type: 'megastructure', ...orbit };
      const back = bodyPositionAt(site, new Map([...byId, ['site', site]]), tick);
      const err = Math.hypot(back.x - point.x, back.y - point.y);
      check(`t${tick} ${label}: lands on the clicked point`,
        err < 1e-6, `off by ${err.toExponential(2)} units`);
    }
  }
}

// ---- and then behaves like an orbit ----------------------------------
{
  const tick = 500;
  const base = at('jupiter', tick);
  const point = { x: base.x + 400, y: base.y };
  const orbit = deriveSiteOrbit(point, BODIES, tick);
  const site = { id: 'site', type: 'megastructure', ...orbit };
  const m = new Map([...byId, ['site', site]]);

  check('a placed site orbits its parent, not the origin',
    orbit.parent_body_id === 'jupiter', `got ${orbit.parent_body_id}`);

  // Distance from the PARENT must be constant; distance from the origin
  // must not be, because the parent is itself moving.
  const rs = [0, 50, 200, 900].map((d) => {
    const p = bodyPositionAt(site, m, tick + d);
    const j = bodyPositionAt(byId.get('jupiter'), m, tick + d);
    return Math.hypot(p.x - j.x, p.y - j.y);
  });
  const spread = Math.max(...rs) - Math.min(...rs);
  check('...at a constant radius from it',
    spread < 1e-6, `radius wandered by ${spread.toExponential(2)}`);

  const moved = Math.hypot(
    bodyPositionAt(site, m, tick + 200).x - bodyPositionAt(site, m, tick).x,
    bodyPositionAt(site, m, tick + 200).y - bodyPositionAt(site, m, tick).y,
  );
  check('...and actually moves as the game runs', moved > 1, `moved ${moved.toFixed(1)}`);
}

// ---- it keeps step with the moons it was parked among ----------------
{
  // A site at exactly Europa's radius must have exactly Europa's year.
  // This is the assertion that fails if anyone "simplifies" the period
  // to the mu formula.
  const europa = byId.get('europa');
  const T = periodForRadius(byId.get('jupiter'), europa.orbit_radius, BODIES);
  const err = Math.abs(T - europa.orbit_period) / europa.orbit_period;
  check('a site at a moon’s radius shares that moon’s year',
    err < 0.02, `${T.toFixed(1)} vs Europa ${europa.orbit_period.toFixed(1)} (${(err * 100).toFixed(1)}% off)`);

  // Kepler still holds between two radii around the same parent.
  const near = periodForRadius(byId.get('jupiter'), 200, BODIES);
  const far = periodForRadius(byId.get('jupiter'), 800, BODIES);
  check('...and further out is slower, by r^1.5',
    Math.abs(far / near - Math.pow(4, 1.5)) < 0.001,
    `ratio ${(far / near).toFixed(4)} vs ${Math.pow(4, 1.5).toFixed(4)}`);
}

// ---- the innermost sphere of influence wins --------------------------
{
  const tick = 90;
  const io = byId.get('io');
  const ioPos = at('io', tick);
  const inner = soiHolderAt({ x: ioPos.x + (io.soi ?? 1) * 0.4, y: ioPos.y }, BODIES, tick);
  check('a point inside a moon’s SOI belongs to the MOON, not the planet',
    inner?.id === 'io', `got ${inner?.id}`);

  const jup = at('jupiter', tick);
  const outer = soiHolderAt({ x: jup.x + 600, y: jup.y }, BODIES, tick);
  check('a point in the planet’s SOI but no moon’s belongs to the planet',
    outer?.id === 'jupiter', `got ${outer?.id}`);

  const far = soiHolderAt({ x: 15000, y: 15000 }, BODIES, tick);
  check('open space falls through to the primary',
    far?.id === 'sol', `got ${far?.id}`);
}

// ---- capture takes 30%, coherently ----------------------------------
{
  const row = { acc_metal: 4000, acc_credits: 6000, cost_metal: 5000, cost_credits: 7000 };
  const after = applyCapture(row);
  check('capture keeps 70% of metal',
    Math.abs(after.acc_metal - 2800) < 1e-9, `${after.acc_metal}`);
  check('capture keeps 70% of credits',
    Math.abs(after.acc_credits - 4200) < 1e-9, `${after.acc_credits}`);

  // The Dyson rule: one ratio across every bucket, so the site still
  // reads as a single coherent percentage afterwards.
  const before = progressOf(row);
  const now = progressOf({ ...row, ...after });
  check('...and scales both buckets by the SAME ratio',
    Math.abs(now / before - CAPTURE_PROGRESS_KEPT) < 1e-9,
    `progress ${before.toFixed(4)} -> ${now.toFixed(4)}`);

  // Taking a nearly-finished site is still a bargain, and that is a
  // deliberate call. Pinned so it cannot change without being noticed.
  const nearly = { acc_metal: 5000, acc_credits: 7000, cost_metal: 5000, cost_credits: 7000 };
  check('a captured 100% site sits at 70%, not at zero',
    Math.abs(progressOf({ ...nearly, ...applyCapture(nearly) }) - 0.7) < 1e-9);
}

// ---- progress is the worse bucket ------------------------------------
{
  const lopsided = { acc_metal: 5000, acc_credits: 0, cost_metal: 5000, cost_credits: 7000 };
  check('all the metal and none of the credits is 0% built, not 50%',
    progressOf(lopsided) === 0, `${progressOf(lopsided)}`);
  check('...and is not complete', !isComplete(lopsided));
  const rem = remainingFor(lopsided);
  check('...and still wants every credit',
    rem.metal === 0 && rem.credits === 7000, JSON.stringify(rem));
  check('overpaying does not read past 100%',
    progressOf({ acc_metal: 9e9, acc_credits: 9e9, cost_metal: 5000, cost_credits: 7000 }) === 1);
}

// ---- the catalogue is well-formed ------------------------------------
{
  check('seven structures', MEGASTRUCTURE_KINDS.length === 7, `${MEGASTRUCTURE_KINDS.length}`);
  const bad2 = MEGASTRUCTURE_KINDS.filter((k) => {
    const m = MEGASTRUCTURES[k];
    return !m.label || !m.feature || !['fixed', 'mobile'].includes(m.family)
      || !(m.cost.metal > 0) || !(m.cost.credits > 0);
  });
  check('every entry has a label, a gate, a family and a price', bad2.length === 0, bad2.join(', '));
  // Massively expensive is the design, so it is worth asserting rather
  // than trusting: the cheapest structure still dwarfs the Trajectory
  // Thrusters at 2,000, today's most expensive building.
  const cheapest = Math.min(...MEGASTRUCTURE_KINDS.map(
    k => MEGASTRUCTURES[k].cost.metal + MEGASTRUCTURES[k].cost.credits,
  ));
  check('even the cheapest dwarfs the priciest ordinary building',
    cheapest >= 4 * 2000, `cheapest ${cheapest} vs thrusters 2000`);
}

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
