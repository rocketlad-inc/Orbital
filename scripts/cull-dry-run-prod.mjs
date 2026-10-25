#!/usr/bin/env node
// ============================================================================
// What would the idle cull end TODAY? Run against PRODUCTION data.
//
//   node scripts/cull-dry-run-prod.mjs [--now=<iso date>]
//
// It runs the very same selection the hourly sweep runs (worker/cull.js
// findIdleGames / findIdleLobbies) against the read-only adapter of
// scripts/ending-from-prod.mjs: SELECT/WITH only, one statement at a time, no
// run() at all, so nothing here can write to production. The deployed worker
// need not have migration 0188 yet: the script notices the missing no_cull
// column and relies on the code's own never-cull list for the showcase game.
//
// Prints three things:
//   1. the active games that WOULD be ended (id, name, humans, last human
//      action, age, why), and the lobbies that WOULD be closed;
//   2. EVERY currently active game with its last human action, flagged when it
//      would be culled, protected, a Studio test game, or an id the repo or the
//      project notes mention;
//   3. the known ids (showcase, test rooms) and what state production has them in.
//
// Uses the already-installed local wrangler (authenticated for production).
// Windows ARM64 note: do NOT npm install.
// ============================================================================

import { prodEnv } from './ending-from-prod.mjs';
import {
  CULL_AFTER_MS, DAY_MS, NEVER_CULL_IDS, findIdleGames, findIdleLobbies, humanUser, IS_ACTION,
} from '../worker/cull.js';

const arg = process.argv.slice(2).find(a => a.startsWith('--now='));
const now = arg ? Date.parse(arg.slice(6)) : Date.now();
if (!Number.isFinite(now)) { console.error('bad --now'); process.exit(2); }
const cutoff = now - CULL_AFTER_MS;

// Ids the repo and the project notes mention (grep'd 2026-10-24). The staging
// rooms cannot exist on production; they are checked anyway.
const KNOWN = {
  Kai68RfB5BhV: 'marketing showcase (landing, press kit, OG card, Play art)',
  sBtzi1d9ibjC: 'staging: Battle Review room',
  'jRL-aWgpsmMR': 'staging: Intercept Range room',
  psgBIZOOMnUs: 'staging: Missile Range studio game',
  MiYc9k1uHJPW: 'test match (annihilation) used for the film',
  sMu08u1ySzRJ: 'test match (NEXT Zone, Dyson win) used for ending/film',
  '8aC4bfSaiib4': 'test match (Senate win) used for the film',
  qi2UEhRsGCil: 'showcase noted in orbital_lanes (staging)',
};

const DB = prodEnv.DB;
const all = async (sql, ...a) => (await DB.prepare(sql).bind(...a).all()).results ?? [];
const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : '-');
const age = (ms) => (ms ? `${Math.max(0, Math.floor((now - ms) / DAY_MS))}d` : "-");
const cell = (s, n) => String(s ?? '').replace(/\|/g, '/').slice(0, n);

let hasNoCull = true;
try { await all('SELECT no_cull FROM games LIMIT 1'); } catch { hasNoCull = false; }

console.log(`# Idle cull dry run against production`);
console.log(`now = ${day(now)}   cutoff (15 days) = ${day(cutoff)}   no_cull column on prod: ${hasNoCull ? 'yes' : 'NO (migration 0188 not deployed yet; showcase protected by the code list)'}`);
console.log(`never-cull ids in code: ${NEVER_CULL_IDS.join(', ')}\n`);

const byStatus = await all('SELECT status, COUNT(*) AS n FROM games GROUP BY status ORDER BY n DESC');
console.log('games by status: ' + byStatus.map(r => `${r.status}=${r.n}`).join(', '));
const roomStatus = await all('SELECT status, COUNT(*) AS n FROM rooms GROUP BY status ORDER BY n DESC');
console.log('rooms by status: ' + roomStatus.map(r => `${r.status}=${r.n}`).join(', ') + '\n');

// ---- 1. what would go -----------------------------------------------------
const idleGames = await findIdleGames(prodEnv, now, { limit: 5000, noCullColumn: hasNoCull });
const idleLobbies = await findIdleLobbies(prodEnv, now, { limit: 5000 });
const idleIds = new Set(idleGames.map(g => g.id));

console.log(`## Games that WOULD be ended (${idleGames.length})\n`);
console.log('| id | name | status | humans | last human action | idle | last watched (heartbeat) | flags | why |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const g of idleGames) {
  const flags = [g.solo && 'solo', g.trial && 'trial', KNOWN[g.id] && 'KNOWN'].filter(Boolean).join(',');
  const watched = g.lastHumanBeatMs && g.lastHumanBeatMs >= cutoff ? `${day(g.lastHumanBeatMs)} (within 15d)` : day(g.lastHumanBeatMs);
  console.log(`| ${g.id} | ${cell(g.name, 32)} | ${g.status} | ${g.humans} | ${day(g.lastActivityMs)} | ${g.idleDays}d | ${watched} | ${flags} | ${g.reason} |`);
}
const watchedOnly = idleGames.filter(g => g.lastHumanBeatMs && g.lastHumanBeatMs >= cutoff);
console.log(`\n${watchedOnly.length} of those were still WATCHED (a human heartbeat) inside the last 15 days without any action: ${watchedOnly.map(g => g.id).join(', ') || 'none'}.`);

console.log(`\n## Lobbies that WOULD be closed (${idleLobbies.length})\n`);
console.log('| id | name | members/seats | quick | last touched | idle | why |');
console.log('|---|---|---|---|---|---|---|');
for (const l of idleLobbies) {
  console.log(`| ${l.id} | ${cell(l.name, 32)} | ${l.humans}/${l.seats} | ${l.quickJoin ? 'yes' : ''} | ${day(l.lastActivityMs)} | ${l.idleDays}d | ${l.reason} |`);
}

// ---- 2. every active game ---------------------------------------------------
const noCullCol = hasNoCull ? 'COALESCE(g.no_cull, 0)' : '0';
const active = await all(
  `SELECT g.id, r.name, r.status AS room_status, g.current_tick, g.started_at, g.created_at, g.solo, g.trial,
          COALESCE(g.is_test_game, 0) AS is_test, ${noCullCol} AS no_cull, s.last_action_ms, s.last_beat_ms,
          (SELECT COUNT(*) FROM game_factions f JOIN users u ON u.id = f.user_id
            WHERE f.game_id = g.id AND f.ai_doctrine IS NULL AND ${humanUser('u.email')}) AS humans,
          (SELECT MAX(e.created_at_ms) FROM analytics_events e JOIN users u ON u.id = e.user_id
            WHERE e.game_id = g.id AND e.created_at_ms >= ? AND ${IS_ACTION} AND ${humanUser('u.email')}) AS recent_ms
     FROM games g JOIN rooms r ON r.id = g.id LEFT JOIN analytics_game_seen s ON s.game_id = g.id
    WHERE g.status = 'active'
    ORDER BY COALESCE(s.last_action_ms, g.started_at, g.created_at) ASC, g.id ASC`,
  now - 30 * DAY_MS);

console.log(`\n## Every ACTIVE game (${active.length}), oldest activity first\n`);
console.log('| id | name | room | humans | last human action | idle | verdict | flags |');
console.log('|---|---|---|---|---|---|---|---|');
for (const a of active) {
  const rollup = Number(a.last_action_ms) || 0;
  const started = Number(a.started_at ?? a.created_at) || 0;
  const last = Math.max(rollup, Number(a.recent_ms) || 0, started);
  const never = NEVER_CULL_IDS.includes(a.id) || Number(a.no_cull) === 1;
  const verdict = idleIds.has(a.id) ? 'CULL'
    : never ? 'protected (no_cull)'
    : Number(a.is_test) === 1 ? 'skipped (Studio test game)'
    : 'keeps running';
  const flags = [a.solo && 'solo', a.trial && 'trial', a.room_status === 'closed' && 'room closed', KNOWN[a.id] && `KNOWN: ${KNOWN[a.id]}`].filter(Boolean).join('; ');
  const src = rollup >= started ? '' : ' (start)';
  console.log(`| ${a.id} | ${cell(a.name, 32)} | ${a.room_status} | ${a.humans} | ${day(last)}${src} | ${age(last)} | ${verdict} | ${flags} |`);
}
const wouldKeep = active.filter(a => !idleIds.has(a.id)).length;
console.log(`\nactive ${active.length}: ${idleIds.size} would be ended, ${wouldKeep} keep running.`);

// ---- 3. the known ids --------------------------------------------------------
console.log('\n## Ids the repo / project notes mention\n');
console.log('| id | what | on production |');
console.log('|---|---|---|');
for (const [id, what] of Object.entries(KNOWN)) {
  const g = await DB.prepare(`SELECT g.status, g.victory_type, r.status AS room_status, ${noCullCol} AS no_cull
                                FROM games g JOIN rooms r ON r.id = g.id WHERE g.id = ?`).bind(id).first();
  const r = g ? null : await DB.prepare('SELECT status FROM rooms WHERE id = ?').bind(id).first();
  const state = g ? `game ${g.status}${g.victory_type ? `/${g.victory_type}` : ''}, room ${g.room_status}${Number(g.no_cull) === 1 ? ', no_cull' : ''}${idleIds.has(id) ? ', WOULD BE CULLED' : ''}`
    : r ? `room only (${r.status})` : 'not on production';
  console.log(`| ${id} | ${what} | ${state} |`);
}
