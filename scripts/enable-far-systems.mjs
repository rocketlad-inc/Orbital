// ============================================================
// enable-far-systems — bring Centauri and Cygnus X-1 into games that are
// ALREADY RUNNING, the way a production rollout would.
//
//   node scripts/enable-far-systems.mjs <env>                 dry run
//   node scripts/enable-far-systems.mjs <env> --apply
//   node scripts/enable-far-systems.mjs <env> --only=<gameId> (repeatable)
//   node scripts/enable-far-systems.mjs <env> --skip=<gameId> (repeatable)
//   node scripts/enable-far-systems.mjs <env> --new-games     also the
//        published config, so games created from now on get them too
//
// WHY A SCRIPT. A game reads its dials from the config row it points at
// (games.config_id), and the far systems are a dial (far_systems). Games
// that predate the dial point at configs without it, or at none at all
// (shipped defaults). And the body backfill only runs when a host
// force-ticks, which almost no host ever does. So turning the far systems
// on for running games is two steps for every game, done here:
//   1. far_systems = 1 in the config it reads. A SHARED config row is
//      edited in place (every active game on it is in scope; a game you
//      --skip moves off it onto a frozen copy first). A game with no
//      config gets one of its own: shipped defaults plus far_systems.
//   2. factions.backfillMissingBodies, the same function the force-tick
//      runs, against the remote database: 52 far bodies per game, built
//      at the game's own dials (sim:farbackfill holds it to a game seeded
//      with them).
// The sun gates need nothing: the next tick sees far_systems and rolls
// the omen, and a game past its roll starts it twelve ticks later.
//
// SAFE. A dry run writes nothing. --apply writes a rollback SQL file
// FIRST (configs restored, inserted bodies retired, never deleted: a
// CASCADE would take any ship parked on one), then applies. Re-running is
// a no-op for games that already have the systems.
// ============================================================

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [envName, ...flags] = process.argv.slice(2);
const APPLY = flags.includes('--apply');
const NEW_GAMES = flags.includes('--new-games');
const listFlag = (name) => flags.filter(f => f.startsWith(`--${name}=`)).map(f => f.slice(name.length + 3))
  .filter(id => /^[A-Za-z0-9_-]+$/.test(id));
const SKIP = new Set(listFlag('skip'));
const ONLY = new Set(listFlag('only'));
if (!['production', 'staging'].includes(envName)) {
  console.error('usage: node scripts/enable-far-systems.mjs <production|staging> [--apply] [--only=<id>] [--skip=<id>] [--new-games]');
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
/** SQL with its parameters written in: `?` in order, `?N` by number. */
function inline(sql, params) {
  let i = 0;
  return sql.replace(/\?(\d+)?/g, (_, n) => lit(params[n ? Number(n) - 1 : i++]));
}
function remoteQuery(sql) {
  // Line comments go first: the query is sent as ONE line, where a
  // `--` would comment out everything after it.
  const oneLine = sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
  const out = execSync(
    `npx wrangler d1 execute ${DB_NAME}${ENV_FLAG} --remote --json --command "${oneLine.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  return JSON.parse(out.slice(out.indexOf('[')))[0]?.results ?? [];
}
function remoteFile(statements) {
  const file = path.join(os.tmpdir(), `enable-far-${Date.now()}.sql`);
  fs.writeFileSync(file, statements.map(s => s.replace(/;\s*$/, '') + ';').join('\n'));
  execSync(`npx wrangler d1 execute ${DB_NAME}${ENV_FLAG} --remote --file "${file}"`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  fs.unlinkSync(file);
}

/** env.DB for worker code. Reads go to the database; writes are written
 *  to `log` and, unless `dry`, sent in one file per batch. */
function remoteDB({ dry, log }) {
  const stmt = (sql) => ({
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
      if (!dry) remoteFile([s]);
      return { meta: { changes: 1 } };
    },
  });
  return {
    prepare: stmt,
    async batch(stmts) {
      const ss = stmts.map(s => inline(s._sql, s._p));
      log.push(...ss);
      if (!dry && ss.length) remoteFile(ss);
      return ss.map(() => ({ meta: { changes: 1 } }));
    },
  };
}

// ---- the plan ----------------------------------------------------------

const { invalidate } = await import('../worker/gameConfig.js');
const { settleOmenTick } = await import('../worker/sunGates.js');
const factions = await import('../worker/factions.js');

const games = remoteQuery(`
  SELECT g.id, g.current_tick, g.config_id, g.sun_gate_tick, c.overrides, c.status AS cfg_status,
         (SELECT COUNT(*) FROM game_bodies b WHERE b.game_id = g.id AND b.template_id = 'binary_barycenter') AS has_far
    FROM games g LEFT JOIN game_configs c ON c.id = g.config_id
   WHERE g.status = 'active'
   ORDER BY g.id`);
const inScope = (g) => !SKIP.has(g.id) && (ONLY.size === 0 || ONLY.has(g.id));
const parse = (s) => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };

const configEdits = new Map();     // config id -> { before, after }
const newConfigs = [];             // { gameId, id, overrides }
const moveOff = [];                // { gameId, from, id, overrides } for skipped games on an edited config
const rows = [];
for (const g of games) {
  const scope = inScope(g);
  const ov = parse(g.overrides);
  let action;
  if (!scope) action = SKIP.has(g.id) ? 'skipped' : 'not selected';
  else if (Number(g.has_far) > 0 && Number(ov.far_systems) === 1) action = 'already has them';
  else if (!g.config_id) {
    const id = `cfg_far_${g.id}`.slice(0, 64);
    newConfigs.push({ gameId: g.id, id, overrides: { far_systems: 1 } });
    action = `new config ${id}`;
  } else {
    if (Number(ov.far_systems) !== 1 && !configEdits.has(g.config_id)) {
      configEdits.set(g.config_id, { before: g.overrides, after: JSON.stringify({ ...ov, far_systems: 1 }) });
    }
    action = Number(ov.far_systems) === 1 ? `config ${g.config_id} already on` : `edit ${g.config_id}`;
  }
  rows.push({ ...g, action, scope });
}
// A game that must NOT change but shares a config we are editing moves to
// a frozen copy of that config first, so the edit cannot reach it.
for (const r of rows) {
  if (r.scope || !r.config_id || !configEdits.has(r.config_id)) continue;
  const id = `cfg_frozen_${r.id}`.slice(0, 64);
  moveOff.push({ gameId: r.id, from: r.config_id, id, overrides: r.overrides });
  r.action += ` (moved to ${id} so the edit misses it)`;
}

let published = null;
if (NEW_GAMES) {
  published = remoteQuery(`SELECT id, overrides FROM game_configs WHERE status = 'published' ORDER BY published_ms DESC LIMIT 1`)[0] ?? null;
}

// Body counts and omen ticks, by running the real backfill on a dry DB.
const now = Date.now();
const insertedIds = new Map();
for (const r of rows) {
  if (!r.scope || r.action === 'already has them') continue;
  const ov = { ...parse(r.overrides), far_systems: 1 };
  r.omen = r.sun_gate_tick != null ? Number(r.sun_gate_tick) : settleOmenTick(r.id, ov, Number(r.current_tick));
  // The dry backfill reads this game's config from the database, where
  // far_systems is still off: point it at an in-memory copy instead.
  const log = [];
  const db = remoteDB({ dry: true, log });
  const realPrepare = db.prepare;
  db.prepare = (sql) => {
    if (/FROM games g\s+JOIN game_configs c/.test(sql)) {
      return { bind() { return this; }, async first() { return { overrides: JSON.stringify(ov) }; }, async all() { return { results: [] }; } };
    }
    return realPrepare(sql);
  };
  invalidate(r.id);
  r.add = await factions.backfillMissingBodies({ DB: db }, r.id, { farOnly: true });
  insertedIds.set(r.id, log.filter(s => /^\s*INSERT/i.test(s))
    .flatMap(s => [...s.matchAll(/VALUES \('([^']+)'/g)].map(m => m[1])));
  invalidate(r.id);
}

console.log(`\nfar systems rollout -- ${envName} -- ${APPLY ? 'APPLY' : 'dry run'}\n`);
for (const r of rows) {
  const omen = r.omen != null ? `omen T${r.omen} (now T${r.current_tick}${r.omen > Number(r.current_tick) ? `, in ${r.omen - Number(r.current_tick)}` : ''})` : '';
  console.log(`${r.id.padEnd(14)} T${String(r.current_tick).padStart(6)}  ${r.action.padEnd(34)} ${r.add != null ? `+${r.add} bodies  ` : ''}${omen}`);
}
for (const [id, e] of configEdits) console.log(`\nconfig ${id}: far_systems -> 1`);
if (published) console.log(`\npublished config ${published.id}: far_systems -> 1 (new games)`);
if (!APPLY) { console.log('\ndry run: nothing written. --apply to roll out.'); process.exit(0); }

// ---- apply ---------------------------------------------------------------

const dir = path.join(os.tmpdir(), 'orbital-far-rollout');
fs.mkdirSync(dir, { recursive: true });
const rollback = path.join(dir, `rollback-${envName}-${new Date().toISOString().replace(/[:.]/g, '-')}.sql`);
const rb = [];
for (const [id, e] of configEdits) rb.push(`UPDATE game_configs SET overrides = ${lit(e.before)} WHERE id = ${lit(id)};`);
if (published) rb.push(`UPDATE game_configs SET overrides = ${lit(published.overrides)} WHERE id = ${lit(published.id)};`);
for (const m of moveOff) rb.push(`UPDATE games SET config_id = ${lit(m.from)} WHERE id = ${lit(m.gameId)};`);
for (const n of newConfigs) rb.push(`UPDATE games SET config_id = NULL WHERE id = ${lit(n.gameId)};`);
for (const r of rows) {
  const ids = insertedIds.get(r.id) ?? [];
  if (ids.length) {
    rb.push(`UPDATE game_bodies SET destroyed_at_tick = (SELECT current_tick FROM games WHERE id = ${lit(r.id)}) WHERE id IN (${ids.map(lit).join(', ')});`);
  }
  if (r.scope && r.sun_gate_tick == null && r.action !== 'already has them') {
    rb.push(`UPDATE games SET sun_gate_tick = NULL WHERE id = ${lit(r.id)};`);
  }
}
fs.writeFileSync(rollback, rb.join('\n') + '\n');
console.log(`\nrollback written: ${rollback}`);

const cfgWrites = [];
for (const m of moveOff) {
  cfgWrites.push(`INSERT OR IGNORE INTO game_configs (id, name, status, overrides, created_ms, updated_ms) VALUES (${lit(m.id)}, 'frozen before far systems', 'archived', ${lit(m.overrides)}, ${now}, ${now})`);
  cfgWrites.push(`UPDATE games SET config_id = ${lit(m.id)} WHERE id = ${lit(m.gameId)}`);
}
for (const [id, e] of configEdits) cfgWrites.push(`UPDATE game_configs SET overrides = ${lit(e.after)}, updated_ms = ${now} WHERE id = ${lit(id)}`);
for (const n of newConfigs) {
  cfgWrites.push(`INSERT OR IGNORE INTO game_configs (id, name, status, overrides, created_ms, updated_ms) VALUES (${lit(n.id)}, 'far systems for a running game', 'archived', ${lit(JSON.stringify(n.overrides))}, ${now}, ${now})`);
  cfgWrites.push(`UPDATE games SET config_id = ${lit(n.id)} WHERE id = ${lit(n.gameId)}`);
}
if (published) cfgWrites.push(`UPDATE game_configs SET overrides = ${lit(JSON.stringify({ ...parse(published.overrides), far_systems: 1 }))}, updated_ms = ${now} WHERE id = ${lit(published.id)}`);
if (cfgWrites.length) remoteFile(cfgWrites);
console.log(`configs: ${cfgWrites.length} writes`);

for (const r of rows) {
  if (!r.scope || r.action === 'already has them') continue;
  invalidate(r.id);
  const added = await factions.backfillMissingBodies({ DB: remoteDB({ dry: false, log: [] }) }, r.id, { farOnly: true });
  const far = remoteQuery(`SELECT COUNT(*) AS n FROM game_bodies WHERE game_id = ${lit(r.id)} AND (template_id IN ('binary_barycenter','bh_barycenter','verdant','requiem') OR template_id LIKE 'mtr_c%')`)[0]?.n;
  console.log(`${r.id}: +${added} bodies (${far} far markers present)`);
}
console.log('\ndone. The next tick of each game rolls its sun-gate omen.');
