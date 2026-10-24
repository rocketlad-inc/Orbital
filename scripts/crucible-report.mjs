#!/usr/bin/env node
// ============================================================
// What happened in a crucible game (scripts/crucible.mjs): standings,
// every war and peace in order, pacts made and broken, what each
// personality tried and was refused, errors, and turn times. Staging.
//
//   node scripts/crucible-report.mjs <gameId> [--json]
// ============================================================

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const G = process.argv[2];
if (!/^[A-Za-z0-9_-]{6,32}$/.test(G ?? '')) throw new Error('usage: crucible-report.mjs <gameId>');

function q(sql) {
  const out = execFileSync(process.execPath, [
    join(process.cwd(), 'node_modules/wrangler/bin/wrangler.js'),
    'd1', 'execute', 'orbital-staging', '--env', 'staging', '--remote', '--json', '--command', sql,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}

const game = q(`SELECT status, current_tick, tick_interval_ms, winner_faction_id, victory_type, started_at, completed_at FROM games WHERE id = '${G}'`)[0];
const factions = q(`SELECT f.id, f.name, f.ai_personality AS p, f.status, f.metal, f.gold, f.science,
    (SELECT COUNT(*) FROM game_bodies b WHERE b.owner_faction_id = f.id AND b.destroyed_at_tick IS NULL) AS worlds,
    (SELECT COUNT(*) FROM game_settlements s WHERE s.owner_faction_id = f.id AND s.destroyed_at_tick IS NULL) AS settlements,
    (SELECT COUNT(*) FROM game_ships s WHERE s.owner_faction_id = f.id AND s.hp > 0 AND s.status = 'active') AS ships
  FROM game_factions f WHERE f.game_id = '${G}' ORDER BY f.slot`);
const name = Object.fromEntries(factions.map(f => [f.id, `${f.name} (${f.p ?? '?'})`]));
const wars = q(`SELECT faction_a, faction_b, declared_by, declared_at_tick, ended_at_tick, origin FROM game_wars WHERE game_id = '${G}' ORDER BY declared_at_tick`);
const treaties = q(`SELECT kind, status, COUNT(*) AS n FROM treaties WHERE game_id = '${G}' GROUP BY kind, status`);
const turns = q(`SELECT personality, COUNT(*) AS n, AVG(ms) AS avg_ms, MAX(ms) AS max_ms,
    SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors FROM ai_turn_log WHERE game_id = '${G}' GROUP BY personality`);
const errors = q(`SELECT tick, faction_id, substr(error, 1, 300) AS error FROM ai_turn_log WHERE game_id = '${G}' AND error IS NOT NULL ORDER BY tick LIMIT 20`);
// Tallies are JSON per turn; sum them per personality in pages.
const sums = {};
for (let off = 0; ; off += 5000) {
  const rows = q(`SELECT personality, tally FROM ai_turn_log WHERE game_id = '${G}' AND tally IS NOT NULL LIMIT 5000 OFFSET ${off}`);
  for (const r of rows) {
    const t = JSON.parse(r.tally);
    const s = (sums[r.personality] ??= {});
    for (const [k, v] of Object.entries(t)) if (!k.startsWith('personality:')) s[k] = (s[k] ?? 0) + v;
  }
  if (rows.length < 5000) break;
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ game, factions, wars, treaties, turns, errors, sums }, null, 2));
  process.exit(0);
}
const hrs = game.started_at ? ((Date.now() - game.started_at) / 3.6e6).toFixed(1) : '?';
console.log(`\nCRUCIBLE ${G}: ${game.status}, tick ${game.current_tick} at ${game.tick_interval_ms / 1000}s, ${hrs} h`);
if (game.winner_faction_id) console.log(`WINNER ${name[game.winner_faction_id]} by ${game.victory_type}`);
console.log('\nStandings');
for (const f of [...factions].sort((a, b) => b.worlds - a.worlds)) {
  console.log(`  ${name[f.id].padEnd(34)} ${f.status.padEnd(10)} worlds ${String(f.worlds).padStart(3)}  settlements ${String(f.settlements).padStart(3)}  ships ${String(f.ships).padStart(4)}  metal ${f.metal} gold ${f.gold}`);
}
console.log('\nWars');
for (const w of wars) {
  const other = w.declared_by === w.faction_a ? w.faction_b : w.faction_a;
  console.log(`  t${w.declared_at_tick}${w.ended_at_tick != null ? `-${w.ended_at_tick}` : '-…'}  ${name[w.declared_by]} -> ${name[other]}${w.origin === 'pact_broken' ? '  BETRAYAL' : ''}`);
}
console.log('\nTreaties', JSON.stringify(treaties));
console.log('\nTurns', JSON.stringify(turns));
if (errors.length) { console.log('\nErrors'); for (const e of errors) console.log(`  t${e.tick} ${name[e.faction_id]}: ${e.error}`); }
console.log('\nWhat each personality tried (refusals are the non-_ok keys)');
for (const [p, s] of Object.entries(sums)) {
  const top = Object.entries(s).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `${k}:${v}`).join('  ');
  console.log(`  ${p}: ${top}`);
}
