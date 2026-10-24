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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
/** Which imported rows each id set is filled from. */
const ID_SET = { game_factions: 'factions', game_bodies: 'bodies', game_ships: 'ships', game_settlements: 'settlements' };
/** Nullable columns that point at rows of those sets. games is copied before
 *  the rows it points at, so its references are always cleared. */
const NULLABLE_REFS = {
  games: { dyson_controller_faction_id: 'factions', dyson_foundation_settlement_id: 'settlements' },
  chronicle_entries: { actor_faction_id: 'factions', target_faction_id: 'factions', body_id: 'bodies', ship_id: 'ships' },
  game_megastructures: { partner_body_id: 'bodies', founded_by_faction_id: 'factions' },
  senate_proposals: { proposer_faction_id: 'factions' },
  game_wars: { ended_by: 'factions', ceasefire_by: 'factions' },
};
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
  // D1's file import splits statements at line ends, so a newline inside a
  // value (an empire's bio) is written as char(10) instead.
  return String(v).split(/\r?\n/).map(part => `'${part.replace(/\r/g, '').replace(/'/g, "''")}'`).join(' || char(10) || ');
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
  const seen = { factions: new Set(), bodies: new Set(), ships: new Set(), settlements: new Set() };
  for (const spec of TABLES) {
    let rows = null;
    // The Cloudflare API drops the odd request: try a read three times.
    for (let attempt = 1; !rows; attempt++) {
      try { rows = (await prodEnv.DB.prepare(`SELECT * FROM ${spec.t} WHERE ${spec.where}`).bind(gameId).all()).results; }
      catch (e) { if (attempt >= 3) throw e; await new Promise(r => setTimeout(r, 3000 * attempt)); }
    }
    // D1's file import checks foreign keys statement by statement (it does
    // not honour defer_foreign_keys), so a world must come after the body it
    // orbits: a binary barycentre was listed after its asteroid.
    if (spec.t === 'game_bodies') {
      const byId = new Map(rows.map(r => [r.id, r]));
      const depth = (r, n = 0) => (r?.parent_body_id && byId.has(r.parent_body_id) && n < 50 ? depth(byId.get(r.parent_body_id), n + 1) + 1 : 0);
      rows = [...rows].sort((a, b) => depth(a) - depth(b));
    }
    const have = stagingCols(spec.t);
    if (ID_SET[spec.t]) for (const r of rows) seen[ID_SET[spec.t]].add(r.id ?? r.body_id);
    for (const r of rows) {
      const row = { ...r };
      if (spec.t === 'rooms') row.host_id = hostId;
      if (spec.t === 'game_factions') row.user_id = null;
      // A nullable reference to a row prod no longer has (a ship long gone,
      // a settlement razed) is cleared, or staging's foreign keys refuse it.
      for (const [col, set] of Object.entries(NULLABLE_REFS[spec.t] ?? {})) {
        if (row[col] != null && !seen[set].has(row[col])) row[col] = null;
      }
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

  // THROUGH D1'S QUERY ENDPOINT, in batches under its 100 KB statement
  // limit. Not `d1 execute --file`: its import API died on the NEXT Zone
  // ("Not currently importing anything", no reason given) on statements the
  // query endpoint runs without complaint.
  const dir = path.join(os.tmpdir(), 'orbital-stage-import');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${gameId}.sql`), stmts.join('\n'));
  let batch = [], size = 0, sent = 0, calls = 0;
  const flush = async () => {
    if (!batch.length) return;
    await stagingQuery(batch.join('\n'));
    sent += batch.length; calls++;
    if (calls % 25 === 0) process.stdout.write(`  ${sent}/${stmts.length} statements\n`);
    batch = []; size = 0;
  };
  for (const s of stmts.slice(1)) {          // the PRAGMA is per file; ordering does its job here
    if (size + s.length > 90_000) await flush();
    batch.push(s); size += s.length;
  }
  await flush();
  process.stdout.write(`  ${sent} statements in ${calls} batches\n`);
  return { total, token };
}

/** The wrangler login's own token (refreshed by running wrangler when it is
 *  about to expire). Read from disk, never printed. */
function wranglerToken() {
  const file = path.join(os.homedir(), '.wrangler/config/default.toml');
  const read = () => {
    const cfg = readFileSync(file, 'utf8');
    return { token: /oauth_token\s*=\s*"([^"]+)"/.exec(cfg)?.[1], exp: Date.parse(/expiration_time\s*=\s*"([^"]+)"/.exec(cfg)?.[1] ?? '') };
  };
  let t = read();
  if (!t.token || !(t.exp > Date.now() + 5 * 60_000)) { stagingSelect('SELECT 1 AS x'); t = read(); }
  if (!t.token) throw new Error('no wrangler login token; run `wrangler login`');
  return t.token;
}
const ACCOUNT_ID = '6eb3b8c98213e8980b94be54810fa57f';
const STAGING_DB_ID = '102ba09d-028c-4227-8dce-e2d61bc3f556';
async function stagingQuery(sql) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${STAGING_DB_ID}/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${wranglerToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sql }),
    });
    const j = await r.json().catch(() => ({}));
    if (j.success) return j;
    if (attempt >= 3 || (j.errors ?? []).some(e => /constraint|syntax|no such/i.test(e.message ?? ''))) {
      throw new Error(`D1: ${JSON.stringify(j.errors ?? r.status).slice(0, 400)}`);
    }
    await new Promise(res => setTimeout(res, 2000 * attempt));
  }
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
