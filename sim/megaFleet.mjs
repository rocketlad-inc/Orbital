// ============================================================
// MEGAFLEET — D1 will not bind an unbounded IN list.
//
// Reported by Noah, forming one fleet out of 147 hulls:
//
//   D1_ERROR: too many SQL variables at offset 318: SQLITE_ERROR
//
// `WHERE id IN (${ids.map(() => '?').join(',')})` reads as obviously
// correct, and is, until a player selects more ships than D1 will bind.
// **D1 caps a query at 100 bound parameters** — not SQLite's 999 — and
// nothing in the query hints at it. Every bulk endpoint had the shape,
// so the whole "select a lot and do something" surface broke together
// at about a hundred hulls: form, add, remove, detach, rejoin, stance,
// targeting.
//
// Drives the REAL handlers against a REAL D1 shim with a fleet big
// enough to break them, because the failure is invisible to any test
// that uses a plausible number of ships.
//
// Run: node sim/megaFleet.mjs [shipCount]
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { routes as fleetRoutes } from '../worker/fleets.js';
import { routes as actionRoutes } from '../worker/actions.js';
import { chunkIds, D1_MAX_BOUND_PARAMS } from '../worker/sqlChunk.js';

const N = Number(process.argv[2] ?? 150);
let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

// THE SIM MUST ENFORCE THE PLATFORM'S LIMIT, NOT SQLITE'S.
//
// SimD1 is real SQLite underneath, and SQLite will happily bind
// thousands of parameters. D1 refuses at 100. Written without this
// wrapper the whole file passed with every chunking fix REMOVED —
// twenty green checks proving nothing, against a bug that was live in
// production at the time. A test for a platform ceiling has to model
// the ceiling or it is only testing that the code runs.
function d1Strict(db) {
  const wrapStmt = (stmt) => ({
    bind(...args) {
      if (args.length > D1_MAX_BOUND_PARAMS) {
        // The message D1 actually returns, so a failure here reads the
        // same as the one Noah pasted from the game.
        throw new Error(
          `D1_ERROR: too many SQL variables at offset 318: SQLITE_ERROR (${args.length} bound)`);
      }
      return wrapStmt(stmt.bind(...args));
    },
    all: (...a) => stmt.all(...a),
    first: (...a) => stmt.first(...a),
    run: (...a) => stmt.run(...a),
    raw: (...a) => stmt.raw?.(...a),
  });
  return {
    prepare: (sql) => wrapStmt(db.prepare(sql)),
    batch: (stmts) => db.batch(stmts),
    exec: (...a) => db.exec?.(...a),
    applyMigrations: (...a) => db.applyMigrations(...a),
  };
}

const RAW = new SimD1(':memory:');
RAW.applyMigrations(MIGRATIONS);
const DB = d1Strict(RAW);
const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
const G = 'gmegafleet1';
const now = Date.now();
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES ('u1','a@t','A','x',?)`).bind(now).run();
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?,'Mega','u1',?,?)`).bind(G, now, now).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at) VALUES (?,'setup','mega',50,3600000,?,?)`).bind(G, now, now).run();
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,?,?,'earth')`).bind(G, 'u1', now).run();
const factions = await import('../worker/factions.js');
await factions.seedGameWorld({ ...env, DB: RAW }, G);
await DB.prepare(`UPDATE games SET status='active' WHERE id=?`).bind(G).run();

const me = await DB.prepare(`SELECT id FROM game_factions WHERE game_id=? AND user_id='u1'`).bind(G).first();
const earth = (await DB.prepare(`SELECT id FROM game_bodies WHERE game_id=? AND template_id='earth'`).bind(G).first()).id;

// A fleet big enough to break the old code, each hull with a captain so
// the flagship rule and the captain-banking sweep both have work to do.
const shipIds = [];
for (let i = 0; i < N; i++) {
  const sid = `${G}:mega${i}`;
  const cid = `${G}:cap${i}`;
  await DB.prepare(
    `INSERT INTO game_ships
       (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
        orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
        fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick, captain_id)
     VALUES (?,?,?,?,'destroyer',?, 2,2,0,0,0,1, 99,99,'active',0, 60,60, 10, ?)`,
  ).bind(sid, G, me.id, `Hull ${i}`, earth, cid).run();
  await DB.prepare(
    `INSERT INTO game_captains (id, game_id, faction_id, name, rank, traits_json, ship_id, status, created_at_tick)
     VALUES (?,?,?,?,0,'[]',?,'active',0)`,
  ).bind(cid, G, me.id, `Captain ${i}`, sid).run();
  shipIds.push(sid);
}
check(`${N} hulls staged`, shipIds.length === N);
check('the selection genuinely exceeds what D1 will bind',
  N + 1 > D1_MAX_BOUND_PARAMS, `${N} ids + fixed params vs cap ${D1_MAX_BOUND_PARAMS}`);
check('so it needs more than one statement',
  chunkIds(shipIds, 1).length > 1, `${chunkIds(shipIds, 1).length} chunks`);

const call = async (mods, method, path, body) => {
  for (const r of mods) {
    if (r.method !== method) continue;
    const m = typeof r.pattern === 'string'
      ? (r.pattern === path ? { groups: {} } : null) : path.match(r.pattern);
    if (!m) continue;
    const url = new URL(`https://x${path}`);
    try {
      const res = await r.handle(
        new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
        env,
        { url, params: m.groups ?? {}, session: { user_id: 'u1' } },
      );
      return { status: res.status, body: await res.json().catch(() => null) };
    } catch (e) {
      // A bound-parameter overflow throws rather than returning a
      // response — which is exactly what reached Noah's screen as a red
      // D1_ERROR line. Report it as a failed check instead of taking the
      // whole run down, so the rest of the surface still gets exercised.
      return { status: 500, body: { error: { code: 'threw', message: String(e.message) } } };
    }
  }
  throw new Error(`no route for ${method} ${path}`);
};

// ---- FORM FLEET — the exact button in the report ---------------------
const created = await call(fleetRoutes, 'POST', `/api/games/${G}/fleets`, {
  ship_ids: shipIds, flag_ship_id: shipIds[0], name: 'Superfleet',
});
check('FORM FLEET accepts a fleet bigger than the bind limit',
  created.status === 201, JSON.stringify(created).slice(0, 300));
const fleetId = created.body?.fleet?.id;

const claimed = (await DB.prepare(
  `SELECT COUNT(*) AS n FROM game_ships WHERE game_id=? AND fleet_id=?`).bind(G, fleetId).first()).n;
check('...and every hull actually joined', claimed === N, `${claimed} of ${N}`);

// Captains: the flagship keeps hers, everyone else is banked. This is
// the sweep that ran TWO chunked UPDATEs per batch.
const stillCrewed = (await DB.prepare(
  `SELECT COUNT(*) AS n FROM game_ships WHERE game_id=? AND fleet_id=? AND captain_id IS NOT NULL`)
  .bind(G, fleetId).first()).n;
check('exactly one captain is left at their post', stillCrewed === 1, String(stillCrewed));

// ---- BULK ORDERS — the ATTACK / HOLD / TARGETING row -----------------
const orders = await call(actionRoutes, 'PATCH', `/api/games/${G}/ships/orders`, {
  ship_ids: shipIds, stance: 'hold',
});
if (orders.status === 404) {
  console.log('SKIP  bulk orders route not found under that path');
} else {
  check('bulk orders accept the whole selection', orders.status === 200,
    JSON.stringify(orders).slice(0, 300));
  const held = (await DB.prepare(
    `SELECT COUNT(*) AS n FROM game_ships WHERE game_id=? AND stance='hold'`).bind(G).first()).n;
  check('...and every hull took the order', held >= N, `${held} of ${N}`);
}

// ---- REMOVE / ADD round trip -----------------------------------------
const half = shipIds.slice(0, Math.floor(N / 2));
const removed = await call(fleetRoutes, 'PATCH', `/api/games/${G}/fleets/${fleetId}`,
  { remove_ship_ids: half });
check('removing half the fleet works', removed.status === 200, JSON.stringify(removed).slice(0, 200));
const after = (await DB.prepare(
  `SELECT COUNT(*) AS n FROM game_ships WHERE game_id=? AND fleet_id=?`).bind(G, fleetId).first()).n;
check('...and the right number left', after === N - half.length, `${after}`);

const added = await call(fleetRoutes, 'PATCH', `/api/games/${G}/fleets/${fleetId}`,
  { add_ship_ids: half });
check('adding them back works', added.status === 200, JSON.stringify(added).slice(0, 200));
const restored = (await DB.prepare(
  `SELECT COUNT(*) AS n FROM game_ships WHERE game_id=? AND fleet_id=?`).bind(G, fleetId).first()).n;
check('...and the fleet is whole again', restored === N, String(restored));

// ---- DETACH / REJOIN --------------------------------------------------
const det = await call(fleetRoutes, 'PATCH', `/api/games/${G}/fleets/${fleetId}`,
  { detach_ship_ids: shipIds });
check('detaching every member works', det.status === 200, JSON.stringify(det).slice(0, 200));
const detached = (await DB.prepare(
  `SELECT COUNT(*) AS n FROM game_ships WHERE game_id=? AND fleet_id=? AND fleet_detached=1`)
  .bind(G, fleetId).first()).n;
check('...and they are all marked detached', detached === N, String(detached));

// ---- THE TICK STILL RUNS WITH A FLEET THIS SIZE ----------------------
// The endpoint failures were visible; a throw inside resolveTick is not,
// and takes the turn down for every faction rather than one player.
const store = new Map();
const { Room } = await import('../worker/room.js');
const room = new Room({
  storage: {
    async get(k) { return store.get(k); }, async put(k, v) { store.set(k, v); },
    async delete(k) { return store.delete(k); }, async list() { return new Map(store); },
    async deleteAll() { store.clear(); }, setAlarm() {}, getAlarm() { return null; },
  },
  blockConcurrencyWhile: async (f) => f(),
  broadcast: () => {},
}, env);
let tickErr = null;
try {
  for (let t = 51; t <= 53; t++) {
    await room.resolveTick(G, t);
    await DB.prepare('UPDATE games SET current_tick=? WHERE id=?').bind(t, G).run();
  }
} catch (e) { tickErr = e; }
check('the tick resolves with a megafleet on the board', tickErr === null,
  tickErr ? String(tickErr.message).slice(0, 220) : '');

console.log(bad === 0 ? '\nALL MEGAFLEET CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
