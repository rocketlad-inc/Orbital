// ============================================================
// seed-wars — carry a RUNNING game's existing fighting across the
// war-declaration rollout.
//
//   node scripts/seed-wars.mjs <env> <gameId> [lookbackTicks] [--apply]
//
//   node scripts/seed-wars.mjs production ghhqbPbWz64Y
//   node scripts/seed-wars.mjs production ghhqbPbWz64Y 60 --apply
//
// WHY. Hostility used to be the absence of a treaty, so a live board has
// wars in progress that nothing ever wrote down — there was no war state
// to write them to. Flipping the default to peace without this would
// stop every fight in the game dead and hand an escape to whoever was
// losing. Flipping it WITH this changes nothing for anyone currently
// fighting and everything for everyone who never was.
//
// WHAT COUNTS AS A WAR. Shots actually exchanged, which is the same
// signal room.js already uses to decide that a pair has gone to war for
// the purpose of breaking their standing trade: "the honest signal is
// the one a player would recognise as war". battle_shots records every
// attacker/target faction pair, so the answer is a query, not a guess —
// no new bookkeeping and nothing to drift.
//
// DIRECTION IS DISCARDED on purpose. A war is a pair state, and by the
// time two fleets have traded fire it is nobody's business who fired
// first. The row is stamped origin='seeded' so the record never claims
// a declaration that no one actually made.
//
// DRY RUN BY DEFAULT.
// ============================================================

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [envName, gameId, ...rest] = process.argv.slice(2);
const APPLY = rest.includes('--apply');
const LOOKBACK = Number(rest.find(a => /^\d+$/.test(a)) ?? 120);
if (!envName || !gameId) {
  console.error('usage: node scripts/seed-wars.mjs <env> <gameId> [lookbackTicks] [--apply]');
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

const tick = Number(d1(`SELECT current_tick FROM games WHERE id = '${gameId}'`)[0]?.current_tick);
if (!Number.isFinite(tick)) { console.error(`no such game: ${gameId}`); process.exit(1); }
const since = tick - LOOKBACK;
console.log(`game ${gameId} on ${DB_NAME}, tick ${tick}`);
console.log(`  looking back ${LOOKBACK} ticks, to ${since}\n`);

const names = new Map(d1(
  `SELECT id, name FROM game_factions WHERE game_id = '${gameId}'`,
).map(r => [r.id, r.name]));

// Shots between two DIFFERENT factions, inside the window. A shot at
// one's own hull is friendly fire and not a war.
const shots = d1(
  `SELECT s.attacker_faction_id AS a, s.target_faction_id AS b, COUNT(*) AS n,
          MAX(s.tick_number) AS last_tick
     FROM battle_shots s JOIN battles t ON t.id = s.battle_id
    WHERE t.game_id = '${gameId}' AND s.tick_number >= ${since}
      AND s.attacker_faction_id IS NOT NULL AND s.target_faction_id IS NOT NULL
      AND s.attacker_faction_id <> s.target_faction_id
    GROUP BY s.attacker_faction_id, s.target_faction_id`,
);

const pairs = new Map();
for (const r of shots) {
  const [x, y] = r.a < r.b ? [r.a, r.b] : [r.b, r.a];
  const k = `${x}|${y}`;
  const cur = pairs.get(k) ?? { a: x, b: y, shots: 0, last: 0 };
  cur.shots += Number(r.n) || 0;
  cur.last = Math.max(cur.last, Number(r.last_tick) || 0);
  pairs.set(k, cur);
}

const already = new Set(d1(
  `SELECT faction_a, faction_b FROM game_wars
    WHERE game_id = '${gameId}' AND ended_at_tick IS NULL`,
).map(r => `${r.faction_a}|${r.faction_b}`));

const nameOf = (id) => names.get(id) ?? id;
const toOpen = [...pairs.values()].filter(p => !already.has(`${p.a}|${p.b}`));

console.log(`${pairs.size} pair${pairs.size === 1 ? '' : 's'} exchanged fire in the window`
  + `${already.size ? `, ${already.size} already at war` : ''}:\n`);
for (const p of [...pairs.values()].sort((x, y) => y.shots - x.shots)) {
  const open = already.has(`${p.a}|${p.b}`);
  console.log(`  ${nameOf(p.a).padEnd(24)} vs ${nameOf(p.b).padEnd(24)}`
    + ` ${String(p.shots).padStart(5)} shots, last tick ${p.last}${open ? '   (already at war)' : ''}`);
}

// Everyone NOT on that list is about to be at peace for the first time.
const fids = [...names.keys()];
const totalPairs = (fids.length * (fids.length - 1)) / 2;
console.log(`\n  ${totalPairs} faction pairs in this game`);
console.log(`  ${pairs.size} stay at war, ${totalPairs - pairs.size} become peaceful`);

const writes = toOpen.map(p =>
  `INSERT INTO game_wars (id, game_id, faction_a, faction_b, declared_by, declared_at_tick, origin)`
  + ` VALUES ('war_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}',`
  + ` '${gameId}', '${p.a}', '${p.b}', '${p.a}', ${tick}, 'seeded')`);

if (!writes.length) {
  console.log('\nnothing to open — every fighting pair is already at war.');
  process.exit(0);
}
console.log(`\n--- ROLLBACK ---\nDELETE FROM game_wars WHERE game_id = '${gameId}' AND origin = 'seeded';`);
if (!APPLY) {
  console.log(`\nDRY RUN — ${writes.length} wars withheld. Re-run with --apply.`);
  process.exit(0);
}
const file = path.join(os.tmpdir(), `seed-wars-${gameId}.sql`);
fs.writeFileSync(file, writes.map(s => `${s};`).join('\n'), 'utf8');
execSync(`npx wrangler d1 execute ${DB_NAME} --remote --yes --file "${file}"`,
  { encoding: 'utf8', stdio: 'inherit' });
fs.unlinkSync(file);
console.log(`\napplied — ${writes.length} wars carried across.`);
