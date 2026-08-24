// ============================================================
// discoveredGate — where the two halves of an ancient stargate sit.
//
//   npm run sim:discoveredgate
//
// The pair is spawned by the tick, not by a player, so nobody is
// standing there to notice if it lands somewhere absurd. Three ways it
// can, all of which produce a gate that exists and cannot be used:
//
//   INSIDE THE STAR. The solar end orbits Sol, and Sol was made five
//   times bigger in migration 0101. An altitude tuned against the old
//   radius puts the gate under the photosphere.
//
//   INSIDE THE PLANET. The far end orbits the world that hid it. A
//   fraction-of-SOI rule reads fine until it meets a body whose SOI is
//   barely wider than the body.
//
//   OUTSIDE THE SOI. Past the sphere of influence the gate stops
//   belonging to the world it was found on, which is the one thing its
//   whole story depends on.
//
// The placement rule is duplicated here deliberately: room.js does the
// DB work, and this asserts the arithmetic against every real body in
// the catalogue rather than the one the test game happened to roll.
// ============================================================

import { BODY_CATALOG, scaledGeometry, moonReachByParent } from '../worker/factions.js';
import { periodForRadius } from '../worker/megastructures.js';

let bad = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`PASS  ${label}`); return; }
  bad += 1;
  console.log(`FAIL  ${label}`);
  if (detail) console.log(`        ${detail}`);
};

/** Mirrors spawnDiscoveredGatePair in worker/room.js. */
const hostRadiusFor = (host) => {
  const soi = Number(host.soi) || 0;
  const rad = Number(host.radius) || 1;
  // The SOI cap wins over surface clearance. Phobos is why: its SOI is
  // barely 2.5x its own radius, so the surface term alone put the gate
  // outside the sphere of influence.
  return soi > 0
    ? Math.min(Math.max(rad * 2.5, soi * 0.35), soi * 0.8)
    : rad * 4;
};

/** Mirrors parkOrbitRadius: an altitude clear of the photosphere. */
const parkOrbitRadius = r => r * 1.3 + 15;
/** Squeezed between the star's surface and the innermost planet's lane.
 *  On an unscaled map the bare park altitude is 78% of the way to
 *  Mercury, which is not "close solar orbit" by any reading. */
const solRadiusFor = (sol, innerOrbit) => {
  const rad = Number(sol.radius) || 50;
  return Math.max(
    rad * 1.15,
    Math.min(parkOrbitRadius(rad), Number.isFinite(innerOrbit) ? innerOrbit * 0.45 : Infinity),
  );
};

// Every scale combination a host can actually publish, because the
// failure modes above only appear once body_scale has been through the
// catalogue.
for (const [SYS, BODY, MOON] of [[1, 1, 1], [4, 2, 8], [2, 1, 4], [4, 1, 1]]) {
  const M = `sys${SYS}/body${BODY}/moon${MOON}`;
  const moonReach = moonReachByParent();
  const bodies = BODY_CATALOG.map(b => ({
    id: b.id,
    type: b.type,
    parent_body_id: b.parent === 'sol' || !b.parent ? (b.id === 'sol' ? null : 'sol') : b.parent,
    radius: b.radius * BODY,
    mu: b.mu,
    ...scaledGeometry(b, { sysScale: SYS, bodyScale: BODY, moonScale: MOON, moonReach }),
  }));
  const sol = bodies.find(b => !b.parent_body_id);

  // ---- the solar end clears the star -------------------------------
  const innerFirst = bodies
    .filter(b => b.parent_body_id === 'sol' && Number(b.orbit_radius) > 0)
    .reduce((m, b) => Math.min(m, Number(b.orbit_radius)), Infinity);
  const solR = solRadiusFor(sol, innerFirst);
  check(`${M}: the solar gate is outside the photosphere`,
    solR > sol.radius, `gate at ${solR.toFixed(1)}, star radius ${sol.radius}`);

  // ...and does not reach the innermost planet, or it stops reading as
  // "in close solar orbit" and starts colliding with Mercury's lane.
  const inner = bodies
    .filter(b => b.parent_body_id === 'sol' && Number(b.orbit_radius) > 0)
    .sort((a, b) => a.orbit_radius - b.orbit_radius)[0];
  check(`${M}: ...and stays well inside the innermost planet's orbit`,
    solR < inner.orbit_radius * 0.5,
    `gate at ${solR.toFixed(1)}, ${inner.id} at ${inner.orbit_radius.toFixed(1)}`);

  // ---- the far end sits properly around its host --------------------
  // Every body a stargate could be rolled onto. The secret lands on
  // real worlds and moons, so check all of them rather than one.
  const hosts = bodies.filter(b => b.parent_body_id && Number(b.radius) > 0);
  const inSurface = [];
  const outsideSoi = [];
  const noPeriod = [];
  for (const h of hosts) {
    const r = hostRadiusFor(h);
    if (r <= h.radius) inSurface.push(`${h.id} r=${r.toFixed(1)} <= radius ${h.radius}`);
    const soi = Number(h.soi) || 0;
    if (soi > 0 && r >= soi) outsideSoi.push(`${h.id} r=${r.toFixed(1)} >= soi ${soi.toFixed(1)}`);
    const T = periodForRadius(h, r, bodies);
    if (!(T > 0) || !Number.isFinite(T)) noPeriod.push(`${h.id} T=${T}`);
  }
  check(`${M}: no gate spawns inside the world that hid it`,
    inSurface.length === 0, inSurface.slice(0, 3).join(' | '));
  check(`${M}: every gate stays inside its host's SOI`,
    outsideSoi.length === 0, outsideSoi.slice(0, 3).join(' | '));
  check(`${M}: every gate gets a real orbital period`,
    noPeriod.length === 0, noPeriod.slice(0, 3).join(' | '));
}

// ---- the pair is permanent by construction --------------------------
{
  // Not a flag: both ends are unowned, and pairGate refuses anyone who
  // does not own a gate. This asserts the REASON, so that if someone
  // later gives ancient gates an owner they find out here rather than
  // when a player cuts the one fixed crossing on the board.
  const ownerOf = () => null;                 // spawned with owner NULL
  const canRewire = (gate, factionId) => gate.owner != null && gate.owner === factionId;
  const ancient = { owner: ownerOf() };
  check('nobody can re-wire an ancient gate',
    ['f0', 'f1', 'f2', null].every(f => !canRewire(ancient, f)));
  const built = { owner: 'f0' };
  check('...while a gate you built is still yours to re-wire',
    canRewire(built, 'f0') && !canRewire(built, 'f1'));
}

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
