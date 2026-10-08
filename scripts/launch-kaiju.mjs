// ============================================================
// LAUNCH A LEVIATHAN NOW, into a running game (worker/kaiju.js).
//
// The second sun gate carries one in on its own when a game has the
// `kaiju` dial on. This is for a game whose gates are ALREADY open: the
// beast burns at 2g from its far system for that system's Sol gate and
// hunts from there. Turns the dial on for that game alone first (a game
// on a shared config gets its own copy of it, so nobody else changes).
//
//   node scripts/launch-kaiju.mjs <staging|production> <gameId>
//        [--sys=centauri|cygnus] [--appetite=N] [--apply]
//
// Dry run by default: prints what it would do. --apply does it and
// writes a rollback for the config change to the temp directory. Runs
// the worker's own code against the remote database (the same shim as
// scripts/enable-far-systems.mjs), so the leg is planned exactly as the
// tick would plan it.
//
// The phone/Discord notice for the launch needs the worker's bindings
// and is NOT sent from here; the log, the Herald, the sitrep and every
// later moment (which the tick writes) are.
// ============================================================

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [envName, gameId, ...flags] = process.argv.slice(2);
const APPLY = flags.includes('--apply');
const flag = (name) => flags.find(f => f.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const SYS = flag('sys');
const APPETITE = flag('appetite') != null ? Math.max(1, Math.round(Number(flag('appetite')))) : null;
if (!['production', 'staging'].includes(envName) || !/^[A-Za-z0-9_-]{6,32}$/.test(gameId ?? '')) {
  console.error('usage: node scripts/launch-kaiju.mjs <staging|production> <gameId> [--sys=centauri|cygnus] [--appetite=N] [--apply]');
  process.exit(1);
}
const DB_NAME = envName === 'production' ? 'orbital' : 'orbital-staging';
const ENV_FLAG = envName === 'production' ? '' : ` --env ${envName}`;

// ---- the remote database, behind the D1 interface the worker uses ----
const lit = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`refusing to write a non-finite number: ${v}`);
    return String(v);
  }
  return `'${String(v).replace(/'/g, "''")}'`;
};
function inline(sql, params) {
  let i = 0;
  return sql.replace(/\?(\d+)?/g, (_, n) => lit(params[n ? Number(n) - 1 : i++]));
}
function remoteQuery(sql) {
  const oneLine = sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
  const out = execSync(
    `npx wrangler d1 execute ${DB_NAME}${ENV_FLAG} --remote --json --command "${oneLine.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  return JSON.parse(out.slice(out.indexOf('[')))[0]?.results ?? [];
}
function remoteFile(statements) {
  const file = path.join(os.tmpdir(), `launch-kaiju-${Date.now()}.sql`);
  fs.writeFileSync(file, statements.map(s => s.replace(/;\s*$/, '') + ';').join('\n'));
  execSync(`npx wrangler d1 execute ${DB_NAME}${ENV_FLAG} --remote --file "${file}"`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  fs.unlinkSync(file);
}
const log = [];
const DB = {
  prepare: (sql) => ({
    _sql: sql, _p: [],
    bind(...p) { this._p = p; return this; },
    async all() { return { results: remoteQuery(inline(this._sql, this._p)) }; },
    async first(col) {
      const r = remoteQuery(inline(this._sql, this._p))[0] ?? null;
      return col && r ? r[col] : r;
    },
    async run() {
      const s = inline(this._sql, this._p);
      log.push(s);
      if (APPLY) remoteFile([s]);
      return { meta: { changes: 1 } };
    },
  }),
  async batch(stmts) {
    const ss = stmts.map(s => inline(s._sql, s._p));
    log.push(...ss);
    if (APPLY && ss.length) remoteFile(ss);
    return ss.map(() => ({ meta: { changes: 1 } }));
  },
};
const env = { DB };

// ---- the game, and its dial -------------------------------------------
const [game] = remoteQuery(inline(
  `SELECT g.id, g.status, g.current_tick, g.config_id, c.overrides, r.name
     FROM games g JOIN rooms r ON r.id = g.id LEFT JOIN game_configs c ON c.id = g.config_id
    WHERE g.id = ?`, [gameId]));
if (!game || game.status !== 'active') { console.error(`no active game ${gameId}`); process.exit(1); }
const had = remoteQuery(inline('SELECT phase FROM game_kaiju WHERE game_id = ?', [gameId]));
if (had.length) { console.error(`${gameId} has already had a Leviathan (${had[0].phase})`); process.exit(1); }
const ov = (() => { try { return game.overrides ? JSON.parse(game.overrides) : {}; } catch { return {}; } })();
if (Number(ov.far_systems) !== 1) { console.error(`${gameId} has no far systems`); process.exit(1); }
const next = { ...ov, kaiju: 1, ...(APPETITE ? { kaiju_appetite: APPETITE } : {}) };
const sharers = game.config_id
  ? remoteQuery(inline(`SELECT id FROM games WHERE config_id = ? AND status = 'active' AND id <> ?`, [game.config_id, gameId]))
  : [];
const ownId = `cfg_kaiju_${gameId}`.slice(0, 64);
const rollback = [];
console.log(`${game.name} (${gameId}) at T${game.current_tick}, config ${game.config_id ?? '(none)'}`);
if (!game.config_id || sharers.length > 0) {
  console.log(`  config is shared with ${sharers.length} other game(s): giving this game its own copy, ${ownId}`);
  const now = Date.now();
  await DB.batch([
    DB.prepare(`INSERT OR REPLACE INTO game_configs (id, name, status, overrides, created_ms, updated_ms)
                VALUES (?, ?, 'archived', ?, ?, ?)`).bind(ownId, `Leviathan: ${game.name}`, JSON.stringify(next), now, now),
    DB.prepare('UPDATE games SET config_id = ? WHERE id = ?').bind(ownId, gameId),
  ]);
  rollback.push(inline('UPDATE games SET config_id = ? WHERE id = ?', [game.config_id, gameId]));
} else {
  console.log(`  config ${game.config_id} is this game's alone: turning kaiju on in it`);
  await DB.prepare('UPDATE game_configs SET overrides = ? WHERE id = ?').bind(JSON.stringify(next), game.config_id).run();
  rollback.push(inline('UPDATE game_configs SET overrides = ? WHERE id = ?', [game.overrides, game.config_id]));
}

// ---- launch -------------------------------------------------------------
const { launchKaijuNow } = await import('../worker/kaiju.js');
const { Room } = await import('../worker/room.js');
const store = new Map();
const room = new Room({
  storage: {
    async get(k) { return store.get(k); }, async put(k, v) { store.set(k, v); },
    async delete(k) { return store.delete(k); }, async list() { return new Map(store); },
    async deleteAll() { store.clear(); }, setAlarm() {}, getAlarm() { return null; },
  },
  blockConcurrencyWhile: async (f) => f(),
  getWebSockets: () => [],
  broadcast: () => {},
}, env);
const tick = Number(game.current_tick);
const made = await launchKaijuNow(env, gameId, tick, next, {
  planLeg: (shipId, factionId, fromId, toId, arrive) =>
    room.planLegForShip(gameId, tick, shipId, factionId, fromId, toId, arrive),
}, { sysKey: SYS });
console.log('  launch:', JSON.stringify(made));
console.log(`  ${log.length} write(s)${APPLY ? ' applied' : ' (dry run: nothing written; --apply to do it)'}`);
if (APPLY && rollback.length) {
  const file = path.join(os.tmpdir(), `kaiju-rollback-${gameId}-${Date.now()}.sql`);
  fs.writeFileSync(file, rollback.map(s => `${s};`).join('\n') + '\n');
  console.log(`  config rollback: ${file}`);
}
