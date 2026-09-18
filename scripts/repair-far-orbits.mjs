// ============================================================
// repair-far-orbits — put a running game's far objects where the
// current worldgen would put them.
//
//   node scripts/repair-far-orbits.mjs <env> <gameId> [--apply]
//
//   node scripts/repair-far-orbits.mjs production ghhqbPbWz64Y
//   node scripts/repair-far-orbits.mjs production ghhqbPbWz64Y --apply
//
// WHY. Two defects in games seeded before 2026-09-17, both worst at
// system_scale 4:
//
//   ROGUE ASTEROIDS  scaledGeometry scaled orbit_radius and not the
//                    ellipse (orbit_rp / orbit_ra). The renderer and the
//                    tick position an eccentric body from the ellipse,
//                    so at scale 4 the rogues kept a scale-1 ellipse:
//                    apoapsis around Saturn, axis at Neptune.
//   KUIPER ROCKS     the same mismatch, and on top of it the band itself
//                    reached back inside Neptune at periapsis. In the
//                    first eight-player game the "far" rocks orbited in
//                    the belt, and the far economy never happened.
//
// WHAT IT DOES.
//   Rogues:  scale the ellipse by orbit_radius / ((rp+ra)/2), i.e. by
//            exactly the factor the axis got and the ellipse did not.
//            Phase and period are untouched: the rock jumps straight
//            outward along its current bearing and keeps its rhythm.
//   Kuiper:  redraw with the CURRENT band — kuiperElements against the
//            game's own Pluto — and re-derive the period from the
//            game's own mu, exactly as a fresh seed would. Same helpers
//            as worldgen, so a repaired rock is indistinguishable from a
//            seeded one. Omega and mean anomaly are kept.
//
// WHAT IT DOES NOT TOUCH: belt rocks, L3 rocks, minerals, names,
// discovery records, ownership, anything a player has invested.
//
// DRY RUN BY DEFAULT. Prints the before/after table and writes nothing
// without --apply.
// ============================================================

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  kuiperElements, kuiperAnchor, solMu, orbitPeriodFor,
} from '../worker/meteoroids.js';

const [envName, gameId, ...flags] = process.argv.slice(2);
const APPLY = flags.includes('--apply');

if (!envName || !gameId) {
  console.error('usage: node scripts/repair-far-orbits.mjs <env> <gameId> [--apply]');
  process.exit(1);
}
const DB = envName === 'production' ? 'orbital' : 'orbital-staging';

/** Deterministic PRNG, seeded on the game id so a dry run and the
 *  apply that follows it produce identical placements. */
function makeRand(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function d1(sql) {
  // See repair-rock-bands.mjs for why this is execSync with one quoted
  // command: wrangler is a .cmd on Windows and shell:true re-splits an
  // argv array on the SQL's own spaces.
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  const out = execSync(
    `npx wrangler d1 execute ${DB} --remote --json --command "${oneLine.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  const start = out.indexOf('[');
  const parsed = JSON.parse(out.slice(start));
  return parsed[0]?.results ?? [];
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const r0 = (n) => Math.round(Number(n));

// ---- read the world ----------------------------------------------
const bodies = d1(
  `SELECT id, template_id, name, type, orbit_radius, orbit_period, orbit_rp, orbit_ra,
          mineral_kind, mineral_remaining, exhausted_at_tick
     FROM game_bodies WHERE game_id = ${q(gameId)} AND destroyed_at_tick IS NULL`,
);
if (!bodies.length) {
  console.error(`no bodies for game ${gameId} in ${DB}`);
  process.exit(1);
}

const hosts = bodies
  .filter(b => !b.mineral_kind && b.template_id && b.type !== 'lagrange')
  .map(b => ({
    id: b.template_id, type: b.type,
    orbit_radius: Number(b.orbit_radius), orbit_period: Number(b.orbit_period),
  }));
const byId = new Map(hosts.map(h => [h.id, h]));
const mu = solMu(hosts);
const anchor = kuiperAnchor(byId, hosts);
const rOf = (id) => byId.get(id)?.orbit_radius;

console.log(`game ${gameId} on ${DB}`);
console.log(`  saturn ${rOf('saturn')}  neptune ${rOf('neptune')}  pluto ${rOf('pluto')}  sedna ${rOf('sedna')}`);
console.log(`  derived mu ${Math.round(mu)}, kuiper anchor ${Math.round(anchor)}\n`);

// ---- plan ----------------------------------------------------------
const rand = makeRand(`${gameId}:far-orbits`);
const updates = [];
const rows = [];

const rogues = bodies.filter(b => b.type === 'asteroid' && b.orbit_ra != null && b.orbit_rp != null);
for (const b of rogues) {
  const a = Number(b.orbit_radius);
  const els = (Number(b.orbit_rp) + Number(b.orbit_ra)) / 2;
  const factor = els > 0 ? a / els : 1;
  if (Math.abs(factor - 1) < 0.02) {
    rows.push(['rogue (ok)', b.name, `${r0(b.orbit_rp)}-${r0(b.orbit_ra)}`, `${r0(b.orbit_rp)}-${r0(b.orbit_ra)}`]);
    continue;
  }
  const rp = Number(b.orbit_rp) * factor;
  const ra = Number(b.orbit_ra) * factor;
  updates.push(`UPDATE game_bodies SET orbit_rp = ${rp}, orbit_ra = ${ra} WHERE id = ${q(b.id)};`);
  rows.push([`rogue x${factor.toFixed(2)}`, b.name, `${r0(b.orbit_rp)}-${r0(b.orbit_ra)}`, `${r0(rp)}-${r0(ra)}`]);
}

const kuiper = bodies.filter(b => b.type === 'meteoroid' && b.orbit_ra != null);
for (const b of kuiper) {
  const { ra, rp, a } = kuiperElements(rand, anchor);
  updates.push(
    `UPDATE game_bodies SET orbit_radius = ${a}, orbit_period = ${orbitPeriodFor(a, mu)}, `
    + `orbit_rp = ${rp}, orbit_ra = ${ra} WHERE id = ${q(b.id)};`,
  );
  const dead = b.exhausted_at_tick != null ? ' (exhausted)' : '';
  rows.push([`kuiper${dead}`, b.name, `${r0(b.orbit_rp)}-${r0(b.orbit_ra)}`, `${r0(rp)}-${r0(ra)}`]);
}

console.log('  kind                 body           ellipse before      ellipse after');
for (const [kind, name, from, to] of rows) {
  const moved = from !== to ? '  <-- moved' : '';
  console.log(`  ${String(kind).padEnd(20)} ${String(name).padEnd(14)} ${String(from).padStart(15)}  ${String(to).padStart(15)}${moved}`);
}
console.log(`\n  ${updates.length} bodies to move`);

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply.');
  process.exit(0);
}
if (!updates.length) {
  console.log('\nnothing to apply.');
  process.exit(0);
}

const file = path.join(os.tmpdir(), `repair-far-orbits-${gameId}.sql`);
fs.writeFileSync(file, updates.join('\n'), 'utf8');
execSync(
  `npx wrangler d1 execute ${DB} --remote --yes --file "${file}"`,
  { encoding: 'utf8', stdio: 'inherit' },
);
fs.unlinkSync(file);
console.log('\napplied.');
