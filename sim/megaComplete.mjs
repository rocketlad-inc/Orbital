// ============================================================
// MEGA COMPLETE — a finished structure stops being called a "Site".
//
// Founding names the body `${label} Site`, and the name is stored on
// game_bodies. Nothing renamed it when the last load landed, so a
// finished Weapons Station read "WEAPONS STATION SITE" on the map and
// in the outliner for the rest of the game (Studio clip
// a-megastructure-completes, f200/f293).
//
// Three code paths flip a site to 'complete', and each is driven here
// through the REAL code against a REAL schema:
//   1. a hand delivery (POST .../megastructures/:siteId/deliver);
//   2. a V2 route's dropoff stop (room.js walkRouteStops, via resolveTick);
//   3. a legacy kind='megastructure' supply route (resolveTick).
// Plus the games already running: a structure finished BEFORE the rename
// existed must read correctly in GET /state, without a data migration.
//
// Run: npm run sim:megacomplete
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
const G = 'gmegadone1';
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES ('u1','a@t','A','x',0)`).run();
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?,'Done','u1',0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at) VALUES (?,'setup','done',0,3600000,0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,?,0,'earth')`).bind(G, 'u1').run();
const factions = await import('../worker/factions.js');
await factions.seedGameWorld(env, G);
await DB.prepare(`UPDATE games SET status='active' WHERE id=?`).bind(G).run();
await DB.prepare(`UPDATE game_factions SET metal = 100000, gold = 100000 WHERE game_id = ?`).bind(G).run();
await DB.prepare('DELETE FROM game_ships WHERE game_id = ?').bind(G).run();

const me = await DB.prepare(`SELECT id, capital_body_id FROM game_factions WHERE game_id=? AND user_id='u1'`).bind(G).first();
const luna = (await DB.prepare(`SELECT id FROM game_bodies WHERE game_id=? AND template_id='luna'`).bind(G).first()).id;

const site = async (key, kind, label, status, acc) => {
  const id = `${G}:mega_${key}`;
  await DB.prepare(
    `INSERT INTO game_bodies (id, game_id, template_id, name, type, parent_body_id,
       orbit_radius, orbit_period, angle0, radius, soi, mu, color, owner_faction_id)
     VALUES (?, ?, ?, ?, 'megastructure', ?, 40, 120, 0, 1.6, 0, 100, '#ff8a6b', ?)`,
  ).bind(id, G, `mega_${kind}`, label, luna, me.id).run();
  await DB.prepare(
    `INSERT INTO game_megastructures (body_id, game_id, kind, status, acc_metal, acc_credits,
       cost_metal, cost_credits, founded_by_faction_id, founded_at_tick, completed_at_tick, hp)
     VALUES (?, ?, ?, ?, ?, ?, 100, 100, ?, 0, ?, 3000)`,
  ).bind(id, G, kind, status, acc, acc, me.id, status === 'complete' ? 0 : null).run();
  return id;
};
const freighter = async (id, at, cargo = 0) => {
  await DB.prepare(
    `INSERT INTO game_ships
       (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
        orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
        fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick, cargo_metal, cargo_gold)
     VALUES (?,?,?,?,'freighter',?, 2,2,0,0,0,1, 999,999,'active',0, 40,40, 0, ?, ?)`,
  ).bind(`${G}:${id}`, G, me.id, id, at, cargo, cargo).run();
  return `${G}:${id}`;
};
const nameOf = async (id) => (await DB.prepare('SELECT name FROM game_bodies WHERE id = ?').bind(id).first())?.name;
const statusOf = async (id) => (await DB.prepare('SELECT status FROM game_megastructures WHERE body_id = ?').bind(id).first())?.status;

// A custom name (a Studio scene's, a relic's) is the owner's, not ours.
const custom = await site('custom', 'deep_array', 'Eye of Ceres', 'building', 50);
// A structure finished before this fix: still stored as "... Site".
const old = await site('old', 'gravity_sink', 'Gravity Sink Site', 'complete', 100);

// ---------- 1. HAND DELIVERY ----------
{
  const s = await site('hand', 'weapons_station', 'Weapons Station Site', 'building', 50);
  const ship = await freighter('hand1', s, 200);
  const { routes } = await import('../worker/actions.js');
  const route = routes.find(r => r.method === 'POST' && r.pattern.source.includes('deliver'));
  const path = `/api/games/${G}/megastructures/${encodeURIComponent(s)}/deliver`;
  const m = path.match(route.pattern);
  const res = await route.handle({ json: async () => ({ ship_id: ship }) }, env,
    { url: new URL(`https://x${path}`), params: { ...m.groups, siteId: s }, session: { user_id: 'u1' } });
  const body = JSON.parse(await res.text());
  check('hand delivery: the last load completes the site', body?.site?.status === 'complete', JSON.stringify(body));
  check('hand delivery: the finished body is named "Weapons Station"',
    await nameOf(s) === 'Weapons Station', String(await nameOf(s)));
}

// ---------- 2 + 3. ROUTES, through the real tick ----------
const store = new Map();
const { Room } = await import('../worker/room.js');
const room = new Room({
  storage: {
    async get(k) { return store.get(k); }, async put(k, v) { store.set(k, v); },
    async delete(k) { return store.delete(k); }, async list() { return new Map(store); },
    async deleteAll() { store.clear(); }, setAlarm() {}, getAlarm() { return null; },
  },
  id: { toString: () => 'sim-room' },
  blockConcurrencyWhile: async (f) => f(),
}, env);
room.broadcast = () => {};

// V2 route: carrier parked AT the site with its load staged on the crew
// row and its cursor on the dropoff stop.
const v2Site = await site('v2', 'null_field', 'Null Field Site', 'building', 50);
{
  const ship = await freighter('v2c', v2Site);
  const rid = `${G}:route_v2`;
  await DB.prepare(
    `INSERT INTO game_trade_routes (id, game_id, owner_faction_id, ship_id, origin_body_id, dest_body_id,
       status, created_at_tick, kind) VALUES (?, ?, ?, ?, ?, ?, 'outbound', 0, 'logistics')`,
  ).bind(rid, G, me.id, ship, me.capital_body_id, v2Site).run();
  await DB.prepare(
    `INSERT INTO game_trade_route_stops (id, game_id, route_id, sequence, body_id, action)
     VALUES (?, ?, ?, 0, ?, 'pickup'), (?, ?, ?, 1, ?, 'dropoff')`,
  ).bind(`${rid}:s0`, G, rid, me.capital_body_id, `${rid}:s1`, G, rid, v2Site).run();
  await DB.prepare(
    `INSERT INTO game_trade_route_ships (id, game_id, route_id, ship_id, role, next_stop_seq, cargo_metal, cargo_gold)
     VALUES (?, ?, ?, ?, 'carrier', 1, 200, 200)`,
  ).bind(`${rid}:c0`, G, rid, ship).run();
}

// Legacy kind='megastructure' route: primary parked at the dest.
const legacySite = await site('legacy', 'warp_gate', 'Warp Gate Site', 'building', 50);
{
  const ship = await freighter('legc', legacySite);
  await DB.prepare(
    `INSERT INTO game_trade_routes (id, game_id, owner_faction_id, ship_id, origin_body_id, dest_body_id,
       status, cargo_metal, cargo_gold, created_at_tick, kind) VALUES (?, ?, ?, ?, ?, ?, 'outbound', 200, 200, 0, 'megastructure')`,
  ).bind(`${G}:route_leg`, G, me.id, ship, me.capital_body_id, legacySite).run();
}

let tickErr = null;
try {
  await room.resolveTick(G, 1);
  await DB.prepare('UPDATE games SET current_tick = 1 WHERE id = ?').bind(G).run();
} catch (e) { tickErr = e; }
check('the tick runs', tickErr === null, tickErr ? String(tickErr.stack).slice(0, 400) : '');

check('V2 route dropoff: the site completes', await statusOf(v2Site) === 'complete', String(await statusOf(v2Site)));
check('V2 route dropoff: the finished body is named "Null Field"',
  await nameOf(v2Site) === 'Null Field', String(await nameOf(v2Site)));
check('legacy supply route: the site completes', await statusOf(legacySite) === 'complete', String(await statusOf(legacySite)));
check('legacy supply route: the finished body is named "Warp Gate"',
  await nameOf(legacySite) === 'Warp Gate', String(await nameOf(legacySite)));

// ---------- names that are not ours ----------
await DB.prepare(`UPDATE game_megastructures SET status = 'complete', acc_metal = 100, acc_credits = 100 WHERE body_id = ?`)
  .bind(custom).run();
check('a custom name is never overwritten', await nameOf(custom) === 'Eye of Ceres', String(await nameOf(custom)));

// ---------- 4. GAMES ALREADY RUNNING: read-time display ----------
{
  const { routes } = await import('../worker/state.js');
  const route = routes.find(r => r.method === 'GET' && r.pattern.test(`/api/games/${G}/state`));
  const res = await route.handle(new Request(`https://x/api/games/${G}/state`), env,
    { url: new URL(`https://x/api/games/${G}/state`), params: { gameId: G }, session: { user_id: 'u1' } });
  const state = JSON.parse(await res.text());
  const bodies = state.bodies ?? [];
  const b = (id) => bodies.find(x => x.id === id);
  check('/state carries the bodies', bodies.length > 0, Object.keys(state).join(','));
  check('/state: a structure finished before the fix reads "Gravity Sink"',
    b(old)?.name === 'Gravity Sink', String(b(old)?.name));
  check('/state: a custom name passes through', b(custom)?.name === 'Eye of Ceres', String(b(custom)?.name));
  const building = await site('stillbuilding', 'weapons_station', 'Weapons Station Site', 'building', 10);
  const res2 = await route.handle(new Request(`https://x/api/games/${G}/state`), env,
    { url: new URL(`https://x/api/games/${G}/state`), params: { gameId: G }, session: { user_id: 'u1' } });
  const s2 = JSON.parse(await res2.text());
  check('/state: a site still building keeps "Site"',
    (s2.bodies ?? []).find(x => x.id === building)?.name === 'Weapons Station Site');
}

console.log(bad === 0 ? '\nALL MEGA COMPLETE CHECKS PASS' : `\n${bad} CHECK(S) FAILED`);
process.exit(bad === 0 ? 0 : 1);
