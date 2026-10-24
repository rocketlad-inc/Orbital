#!/usr/bin/env node
// ============================================================================
// Copy finished PRODUCTION matches into the STAGING database, so work on the
// end-of-match film (the Saga Engine) can be watched on staging against real
// matches.
//
//   node scripts/stage-import-match.mjs <gameId ...>
//
// PRODUCTION IS ONLY READ: every prod statement goes through the read-only
// adapter in scripts/ending-from-prod.mjs (SELECT only, one statement at a
// time, no run()). Writes go to `orbital-staging` alone, by
// `wrangler d1 execute orbital-staging --env staging --remote --file`.
//
// What is copied is what the film and the ending read, and nothing private:
// the room's name, the game, its empires (with no player attached: user_id
// is cleared), worlds, settlements, ships, metrics, techs, battles and their
// participants, wars, megastructures, the Senate, the PUBLIC chronicle, the
// replay snapshots, the PUBLIC channel, and the captains who were lost. No
// direct or group messages, no trade offers or agreements, no accounts.
// Each import first clears that game's rows on staging, so it can be re-run.
// Prints a /film/<token> link for each match.
// ============================================================================

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prodEnv } from './ending-from-prod.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(here, '..');
const WRANGLER = [path.join(repoDir, 'node_modules/wrangler/bin/wrangler.js'),
  path.resolve(repoDir, '../../../node_modules/wrangler/bin/wrangler.js')].find(existsSync);
const STAGING_URL = 'https://orbital-staging.lcfeeser.workers.dev';

/** The tables, in insert order (parents first), and the prod rows wanted. */
const TABLES = [
  { t: 'rooms', where: 'id = ?' },
  { t: 'games', where: 'id = ?' },
  { t: 'game_factions', where: 'game_id = ?' },
  { t: 'game_bodies', where: 'game_id = ?' },
  { t: 'game_settlements', where: 'game_id = ?' },
  { t: 'game_ships', where: 'game_id = ?' },
  { t: 'faction_metrics', where: 'game_id = ?' },
  { t: 'faction_techs', where: 'game_id = ?' },
  { t: 'battles', where: 'game_id = ?' },
  { t: 'battle_participants', where: 'battle_id IN (SELECT id FROM battles WHERE game_id = ?)', del: 'battle_id IN (SELECT id FROM battles WHERE game_id = ?)' },
  { t: 'game_ship_stats', where: 'game_id = ?' },
  { t: 'game_wars', where: 'game_id = ?' },
  { t: 'game_megastructures', where: 'game_id = ?' },
  { t: 'senate_proposals', where: 'game_id = ?' },
  { t: 'senate_votes', where: 'proposal_id IN (SELECT id FROM senate_proposals WHERE game_id = ?)', del: 'proposal_id IN (SELECT id FROM senate_proposals WHERE game_id = ?)' },
  { t: 'chronicle_entries', where: "game_id = ? AND visibility = 'public'" },
  { t: 'match_snapshots', where: 'game_id = ?' },
  { t: 'messages', where: "game_id = ? AND scope = 'broadcast' AND actual_sender_faction_id = claimed_sender_faction_id" },
  { t: 'game_captains', where: "game_id = ? AND status = 'lost'" },
];

/** D1's longest statement is 100,000 bytes; stay clear of it. */
const MAX_STATEMENT = 90_000;
const PIECE = 60_000;
/** How to find a row again to append to it (tables without an `id`). */
const KEYS = { match_snapshots: ['game_id', 'tick_number', 'kind'] };

function staging(args, input) {
  return execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', 'orbital-staging', '--env', 'staging', '--remote', ...args],
    { cwd: repoDir, maxBuffer: 1 << 29, stdio: ['ignore', 'pipe', 'pipe'], input }).toString();
}
function stagingSelect(sql) {
  const out = staging(['--json', '--command', sql]);
  const parsed = JSON.parse(out.slice(out.indexOf('[')));
  return parsed[0]?.results ?? [];
}

const lit = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/'/g, "''")}'`;
};

/** The columns staging has for a table (its schema may be ahead of prod's). */
const colsCache = new Map();
function stagingCols(t) {
  if (!colsCache.has(t)) colsCache.set(t, new Set(stagingSelect(`SELECT name FROM pragma_table_info('${t}')`).map(r => r.name)));
  return colsCache.get(t);
}

async function importGame(gameId, hostId) {
  const stmts = ['PRAGMA defer_foreign_keys = on;'];
  // Clear the game's rows on staging, children first.
  for (const spec of [...TABLES].reverse()) {
    const where = (spec.del ?? spec.where.replace(/ AND .*$/, '')).replace(/\?/g, lit(gameId));
    stmts.push(`DELETE FROM ${spec.t} WHERE ${where};`);
  }
  stmts.push(`DELETE FROM game_sagas WHERE game_id = ${lit(gameId)};`);
  stmts.push(`DELETE FROM match_shares WHERE game_id = ${lit(gameId)};`);
  let total = 0;
  for (const spec of TABLES) {
    const rows = (await prodEnv.DB.prepare(`SELECT * FROM ${spec.t} WHERE ${spec.where}`).bind(gameId).all()).results;
    const have = stagingCols(spec.t);
    for (const r of rows) {
      const row = { ...r };
      if (spec.t === 'rooms') row.host_id = hostId;
      if (spec.t === 'game_factions') row.user_id = null;
      const cols = Object.keys(row).filter(c => have.has(c));
      const insert = `INSERT OR REPLACE INTO ${spec.t} (${cols.join(', ')}) VALUES (${cols.map(c => lit(row[c])).join(', ')});`;
      if (insert.length <= MAX_STATEMENT) { stmts.push(insert); continue; }
      // D1 refuses a statement over 100 KB, and a replay keyframe can be
      // nearly twice that: insert the longest text column empty, then append
      // it in pieces, keyed by the row's own identity.
      const big = cols.filter(c => typeof row[c] === 'string').sort((a, b) => row[b].length - row[a].length)[0];
      const key = (KEYS[spec.t] ?? ['id']).map(k => `${k} = ${lit(row[k])}`).join(' AND ');
      stmts.push(`INSERT OR REPLACE INTO ${spec.t} (${cols.join(', ')}) VALUES (${cols.map(c => (c === big ? "''" : lit(row[c]))).join(', ')});`);
      for (let at = 0; at < row[big].length; at += PIECE) {
        stmts.push(`UPDATE ${spec.t} SET ${big} = ${big} || ${lit(row[big].slice(at, at + PIECE))} WHERE ${key};`);
      }
    }
    total += rows.length;
    process.stdout.write(`  ${spec.t}: ${rows.length}\n`);
  }
  // A share link, so the film can be opened without an account.
  const token = `stg${gameId.replace(/[^A-Za-z0-9]/g, '')}film`;
  stmts.push(`INSERT OR REPLACE INTO match_shares (token, game_id, created_by, created_at_ms) VALUES (${lit(token)}, ${lit(gameId)}, NULL, ${Date.now()});`);

  // D1 takes files; keep each well under its limits.
  const dir = path.join(os.tmpdir(), 'orbital-stage-import');
  mkdirSync(dir, { recursive: true });
  const parts = [];
  let cur = [stmts[0]], size = 0;
  for (const s of stmts.slice(1)) {
    if (size + s.length > 4_000_000 && cur.length > 1) { parts.push(cur); cur = [stmts[0]]; size = 0; }
    cur.push(s); size += s.length;
  }
  parts.push(cur);
  for (const [i, p] of parts.entries()) {
    const file = path.join(dir, `${gameId}.${i}.sql`);
    writeFileSync(file, p.join('\n'));
    staging(['--file', file, '--yes']);
    process.stdout.write(`  wrote part ${i + 1}/${parts.length}\n`);
  }
  return { total, token };
}

async function main() {
  const ids = process.argv.slice(2).filter(a => /^[A-Za-z0-9_-]{6,32}$/.test(a));
  if (!ids.length) { console.error('usage: node scripts/stage-import-match.mjs <gameId ...>'); process.exit(2); }
  const host = stagingSelect('SELECT id FROM users ORDER BY created_at LIMIT 1')[0]?.id;
  if (!host) throw new Error('staging has no users to own the imported rooms');
  for (const id of ids) {
    console.log(`${id}:`);
    const { total, token } = await importGame(id, host);
    console.log(`  ${total} rows · film: ${STAGING_URL}/film/${token}`);
  }
}

main().catch((e) => { console.error(e?.stderr?.toString?.() || e); process.exit(1); });
