// ============================================================
// respread-shell — move a RUNNING game's outer worlds onto the
// catalogue's current layout.
//
//   node scripts/respread-shell.mjs <env> <gameId> [--apply]
//
//   node scripts/respread-shell.mjs production ghhqbPbWz64Y
//   node scripts/respread-shell.mjs production ghhqbPbWz64Y --apply
//
// WHY. Spreading the Kuiper shell and splitting it at the cliff is a
// CATALOGUE change, so it only reaches games seeded after it. A live
// board keeps the clump-against-a-void it was born with, and its outer
// system stays one system holding a third of the map.
//
// WHY IT IMPORTS RATHER THAN REIMPLEMENTS. Same reason as
// run-backfill.mjs: scaling is decided in one place (scaledGeometry),
// and a second copy of that judgement living in a script is wrong within
// a week. This reads the game's OWN dials back out of its OWN rows
// rather than trusting a config, then asks the real function what every
// body should be.
//
// THE GUARD THAT MAKES IT SAFE. Pluto, Orcus, Ixion and Sedna did not
// move in the catalogue, so recomputing them MUST reproduce the numbers
// already in the database, to the tick. If they don't, the dials were
// read wrong and the script refuses to write anything. Every other
// number is then right by the same construction. It also refuses if the
// set of bodies it wants to move is not exactly the set expected.
//
// SHIPS UNDER BURN. Transit position is derived from LIVE body positions
// plus a time fraction (worker/state.js), not a frozen trajectory, so
// moving a world stranded nobody — this is the same finding migration
// 0044 wrote down when it doubled the whole map. What DOES need fixing
// is arrival_at_tick, solved for the old distance: left alone, a hull
// mid-transit crosses the new, larger gap in the old time, which is a
// free boost to whoever happened to be flying. Travel is T = 2*sqrt(d/a),
// so the remaining leg stretches by sqrt of the distance ratio — and
// BOTH ends are stretched about the CURRENT tick, because the render
// fraction is (tick - scheduled_t) / (arrival - scheduled_t) and moving
// only the arrival would snap every in-flight hull visibly backward.
//
// DRY RUN BY DEFAULT.
// ============================================================

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BODY_CATALOG, scaledGeometry } from '../worker/factions.js';
import { PLUTINO_TEMPLATES, FAR_REACH_TEMPLATES } from '../worker/systems.js';

const [envName, gameId, ...flags] = process.argv.slice(2);
const APPLY = flags.includes('--apply');
if (!envName || !gameId) {
  console.error('usage: node scripts/respread-shell.mjs <env> <gameId> [--apply]');
  process.exit(1);
}
const DB_NAME = envName === 'production' ? 'orbital' : 'orbital-staging';

function d1(sql) {
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  const out = execSync(
    `npx wrangler d1 execute ${DB_NAME} --remote --json --command "${oneLine.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(out.slice(out.indexOf('[')))[0]?.results ?? [];
}

// ---- what the game currently is -------------------------------------
const live = new Map(d1(
  `SELECT template_id, orbit_radius, orbit_period FROM game_bodies
    WHERE game_id = '${gameId}' AND destroyed_at_tick IS NULL`,
).map(r => [r.template_id, r]));
const tick = Number(d1(`SELECT current_tick FROM games WHERE id = '${gameId}'`)[0]?.current_tick);
if (!live.size || !Number.isFinite(tick)) { console.error(`no such game: ${gameId}`); process.exit(1); }

const cat = new Map(BODY_CATALOG.map(b => [b.id, b]));
const need = (id) => {
  const l = live.get(id), c = cat.get(id);
  if (!l || !c) { console.error(`FATAL: ${id} missing from ${l ? 'catalogue' : 'game'}`); process.exit(1); }
  return [l, c];
};

// THE GAME'S OWN DIALS, read back out of its own rows. Pluto anchors the
// radius scale and Sedna the period, and neither of them moved, so both
// are exact. Reading a config would be a second source of truth.
const [plutoLive, plutoCat] = need('pluto');
const [sednaLive, sednaCat] = need('sedna');
const [ceresLive] = need('ceres');
const sysScale = plutoLive.orbit_radius / plutoCat.orbit_radius;
const outerSpeedup = sednaCat.orbit_period / sednaLive.orbit_period;
const beltRadius = ceresLive.orbit_radius;
console.log(`game ${gameId} on ${DB_NAME}, tick ${tick}`);
console.log(`  system scale ${sysScale}, outer speed-up ${outerSpeedup}, belt at ${beltRadius}\n`);

// ---- what the catalogue says it should be ---------------------------
const round = (v) => Math.round(v * 100) / 100;
const moves = [];
const drift = [];
// ONLY THE SHELL. This game's Jupiter sits at 4600 against a catalogue
// 3680 — it was hand-moved in the map editor, and scaledGeometry has an
// orbitOverride for exactly that. Walking the whole catalogue would
// "correct" every deliberate edit in the game back to stock. The shell
// is what this script is for, so the shell is all it looks at.
const SHELL = new Set([...PLUTINO_TEMPLATES, ...FAR_REACH_TEMPLATES,
  'mani', 'salacia', 'varuna', 'haumea', 'quaoar']);
for (const b of BODY_CATALOG) {
  if (b.parent !== 'sol' || !SHELL.has(b.id)) continue;   // moons are parent-relative
  const l = live.get(b.id);
  if (!l) continue;                                 // not in this game
  const g = scaledGeometry(b, { sysScale, outerSpeedup, beltRadius });
  const dr = Math.abs((g.orbit_radius ?? 0) - l.orbit_radius);
  const dt = Math.abs((g.orbit_period ?? 0) - l.orbit_period);
  // A tick of slack on the period: seeding rounded these on the way in,
  // so Ixion sits at 4922 against a recomputed 4921.5 and is not a
  // world that moved. A misread scale is out by a FACTOR, never by half
  // a tick, so this costs the guard nothing.
  if (dr < 0.5 && dt <= 1) continue;
  (dr > 0.5 ? moves : drift).push({
    id: b.id,
    fromR: l.orbit_radius, toR: Math.round(g.orbit_radius),
    fromT: l.orbit_period, toT: round(g.orbit_period),
  });
}

// ---- guards ---------------------------------------------------------
// Anything that did NOT move in the catalogue must reproduce exactly, or
// the dials are wrong and every other number is wrong with them.
for (const id of [...PLUTINO_TEMPLATES, 'sedna']) {
  if (!live.has(id)) continue;
  if (moves.some(m => m.id === id) || drift.some(m => m.id === id)) {
    console.error(`FATAL: ${id} did not move in the catalogue but recomputes differently.`);
    console.error('       The scale was read wrong. Nothing written.');
    process.exit(1);
  }
}
const EXPECTED = new Set([...FAR_REACH_TEMPLATES,
  'mani', 'salacia', 'varuna', 'haumea', 'quaoar'].filter(id => id !== 'sedna'));
const got = new Set(moves.map(m => m.id));
const unexpected = [...got].filter(id => !EXPECTED.has(id));
const absent = [...EXPECTED].filter(id => !got.has(id));
if (unexpected.length || absent.length) {
  console.error(`FATAL: the move set is not the shell.\n  unexpected: ${unexpected.join(', ') || '-'}`);
  console.error(`  missing:    ${absent.join(', ') || '-'}\n  Nothing written.`);
  process.exit(1);
}

console.log(`${moves.length} worlds move:\n`);
for (const m of moves) {
  const pct = Math.round((m.toR / m.fromR - 1) * 100);
  console.log(`  ${m.id.padEnd(10)} r ${String(m.fromR).padStart(6)} -> ${String(m.toR).padStart(6)}`
    + ` (${pct >= 0 ? '+' : ''}${pct}%)   T ${String(m.fromT).padStart(8)} -> ${m.toT}`);
}
if (drift.length) {
  console.log(`\n${drift.length} keep their orbit but re-derive a period:`);
  for (const m of drift) console.log(`  ${m.id.padEnd(10)} T ${m.fromT} -> ${m.toT}`);
}

// ---- ships under burn -----------------------------------------------
const ratio = new Map(moves.map(m => [m.id, m.toR / m.fromR]));
const inFlight = d1(
  `SELECT n.id, n.ship_id, n.target_body_id, n.scheduled_t, n.arrival_at_tick, s.name
     FROM game_ship_nodes n JOIN game_ships s ON s.id = n.ship_id
    WHERE n.game_id = '${gameId}' AND n.status = 'in_transit'
      AND n.target_body_id IS NOT NULL AND n.arrival_at_tick > ${tick}`,
).filter(n => ratio.has(String(n.target_body_id).split(':').pop()));

const writes = [];
for (const m of moves) {
  writes.push(`UPDATE game_bodies SET orbit_radius = ${m.toR}, orbit_period = ${m.toT}`
    + ` WHERE game_id = '${gameId}' AND template_id = '${m.id}'`);
}
console.log(`\n${inFlight.length} hull${inFlight.length === 1 ? '' : 's'} mid-transit to a moved world:`);
for (const n of inFlight) {
  const k = Math.sqrt(ratio.get(String(n.target_body_id).split(':').pop()));
  const sched = round(tick - (tick - n.scheduled_t) * k);
  const arr = Math.round(tick + (n.arrival_at_tick - tick) * k);
  console.log(`  ${String(n.name).padEnd(14)} -> ${String(n.target_body_id).split(':').pop().padEnd(10)}`
    + ` arrives ${n.arrival_at_tick} -> ${arr} (leg x${round(k)})`);
  writes.push(`UPDATE game_ship_nodes SET scheduled_t = ${sched}, arrival_at_tick = ${arr}`
    + ` WHERE id = '${n.id}'`);
}
if (!inFlight.length) console.log('  (none)');

// The exact inverse, printed so a mistake is one paste away from undone.
// Cheaper and more honest than trying to detect every hand-edit.
console.log('\n--- ROLLBACK (paste into d1 execute --file if this goes wrong) ---');
for (const m of moves) {
  console.log(`UPDATE game_bodies SET orbit_radius = ${m.fromR}, orbit_period = ${m.fromT}`
    + ` WHERE game_id = '${gameId}' AND template_id = '${m.id}';`);
}
for (const n of inFlight) {
  console.log(`UPDATE game_ship_nodes SET scheduled_t = ${n.scheduled_t},`
    + ` arrival_at_tick = ${n.arrival_at_tick} WHERE id = '${n.id}';`);
}
console.log('--- end rollback ---');

if (!APPLY) {
  console.log(`\nDRY RUN — ${writes.length} statements withheld. Re-run with --apply.`);
  process.exit(0);
}
const file = path.join(os.tmpdir(), `respread-${gameId}.sql`);
fs.writeFileSync(file, writes.map(s => `${s};`).join('\n'), 'utf8');
execSync(`npx wrangler d1 execute ${DB_NAME} --remote --yes --file "${file}"`,
  { encoding: 'utf8', stdio: 'inherit' });
fs.unlinkSync(file);
console.log('\napplied.');
