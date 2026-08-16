// ============================================================
// repair-rock-bands — move an existing game's meteoroids into the
// bands they should have been seeded into.
//
//   node scripts/repair-rock-bands.mjs <env> <gameId> [--apply]
//
//   node scripts/repair-rock-bands.mjs staging Gbsg-tnfqSpP
//   node scripts/repair-rock-bands.mjs staging Gbsg-tnfqSpP --apply
//
// WHY. Belt and Kuiper distances were hard-coded literals written
// against the UNSCALED body catalogue, while factions.js doubles every
// heliocentric orbit at load and meteoroids are generated afterwards.
// Every game seeded before the fix therefore has its belt sitting on
// top of Earth (336-404, with Earth at 372) and its "Kuiper" rocks
// between Uranus and Neptune. Worldgen is fixed, but a running game
// keeps the world it was born with.
//
// It uses the SAME helpers worldgen does — beltRadius, kuiperElements,
// kuiperAnchor, solMu, orbitPeriodFor — so a repaired rock lands
// exactly where a freshly seeded one would. Writing a second placement
// implementation here is how the two would drift.
//
// WHAT IT DOES NOT TOUCH: mineral kind, tonnage, remaining, names,
// discovery records, or L3 rocks. L3 rocks inherit their host's orbit
// and were always correct. Everything a player has invested in a rock
// survives; only where it orbits changes.
//
// DRY RUN BY DEFAULT. Prints the before/after table and writes nothing
// without --apply.
// ============================================================

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  beltRadius, kuiperElements, kuiperAnchor, solMu, orbitPeriodFor,
} from '../worker/meteoroids.js';

const [envName, gameId, ...flags] = process.argv.slice(2);
const APPLY = flags.includes('--apply');

if (!envName || !gameId) {
  console.error('usage: node scripts/repair-rock-bands.mjs <env> <gameId> [--apply]');
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
  // execSync with an explicitly quoted command, NOT execFileSync with
  // an argv array: on Windows wrangler is a .cmd, so execFileSync needs
  // shell:true, and shell:true then re-splits the SQL argument on its
  // spaces and commas. The SQL only ever uses single quotes for
  // literals, so wrapping the whole thing in double quotes is safe.
  // Collapse newlines too — a multi-line command reaches the shell as
  // several arguments and D1 answers "incomplete input".
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  const out = execSync(
    `npx wrangler d1 execute ${DB} --remote --json --command "${oneLine.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  // wrangler prints banners around the JSON on some versions.
  const start = out.indexOf('[');
  const parsed = JSON.parse(out.slice(start));
  return parsed[0]?.results ?? [];
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// ---- read the world ----------------------------------------------
const bodies = d1(
  `SELECT id, template_id, type, orbit_radius, orbit_period, angle0,
          orbit_rp, orbit_ra, mineral_kind, mineral_remaining
     FROM game_bodies WHERE game_id = ${q(gameId)}`,
);
if (!bodies.length) {
  console.error(`no bodies for game ${gameId} in ${DB}`);
  process.exit(1);
}

// Hosts, keyed the way worker/meteoroids.js expects (template ids).
const hosts = bodies
  .filter(b => !b.mineral_kind && b.template_id)
  .map(b => ({
    id: b.template_id,
    type: b.type,
    orbit_radius: Number(b.orbit_radius),
    orbit_period: Number(b.orbit_period),
  }));
const byId = new Map(hosts.map(h => [h.id, h]));
const mu = solMu(hosts);
const anchor = kuiperAnchor(byId, hosts);
const rOf = (id) => byId.get(id)?.orbit_radius;

console.log(`game ${gameId} on ${DB}`);
console.log(`  mars ${rOf('mars')}  jupiter ${rOf('jupiter')}  neptune ${rOf('neptune')}`);
console.log(`  derived mu ${Math.round(mu)}, kuiper anchor ${Math.round(anchor)}`);
console.log('');

// ---- plan the moves ----------------------------------------------
const rand = makeRand(gameId);
const rocks = bodies.filter(b => b.mineral_kind);
const belt = rocks.filter(b => /mtr_belt_/.test(b.template_id || ''));
const kuiper = rocks.filter(b => /mtr_kuiper_|mtr_restock_/.test(b.template_id || ''));
const l3 = rocks.filter(b => b.type === 'lagrange');

const updates = [];
const rows = [];

for (const b of belt) {
  const r = beltRadius(rand, byId);
  updates.push(
    `UPDATE game_bodies SET orbit_radius = ${r}, orbit_period = ${orbitPeriodFor(r, mu)} `
    + `WHERE id = ${q(b.id)};`,
  );
  rows.push(['belt', b.template_id, Math.round(b.orbit_radius), Math.round(r)]);
}

for (const b of kuiper) {
  const { ra, rp, a } = kuiperElements(rand, anchor);
  updates.push(
    `UPDATE game_bodies SET orbit_radius = ${a}, orbit_period = ${orbitPeriodFor(a, mu)}, `
    + `orbit_rp = ${rp}, orbit_ra = ${ra} WHERE id = ${q(b.id)};`,
  );
  rows.push(['kuiper', b.template_id, Math.round(b.orbit_radius), Math.round(a)]);
}

// L3 rocks are pinned to their host and were never wrong, but their
// PERIOD came from the host too — so it is already right. Only report.
for (const b of l3) rows.push(['L3 (kept)', b.template_id, Math.round(b.orbit_radius), Math.round(b.orbit_radius)]);

console.log('  band      rock                 from      to');
for (const [band, id, from, to] of rows) {
  const moved = from !== to ? '  <-- moved' : '';
  console.log(`  ${String(band).padEnd(9)} ${String(id).padEnd(20)} ${String(from).padStart(5)} ${String(to).padStart(7)}${moved}`);
}
console.log('');
console.log(`  ${updates.length} rocks to move, ${l3.length} L3 left alone`);

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply.');
  process.exit(0);
}

const file = path.join(os.tmpdir(), `repair-rocks-${gameId}.sql`);
fs.writeFileSync(file, updates.join('\n'), 'utf8');
execSync(
  `npx wrangler d1 execute ${DB} --remote --yes --file "${file}"`,
  { encoding: 'utf8', stdio: 'inherit' },
);
fs.unlinkSync(file);
console.log('\napplied.');
