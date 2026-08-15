// ============================================================
// FUEL IS ELIMINATED — proven, not asserted.
//
// Fuel had left the ECONOMY long ago (yields zeroed, income zero) but
// not the DATABASE or the API: legacy rows still carried amounts, and
// the endpoints still accepted new ones. This drives the real worker
// against a real schema and checks three things:
//
//   1. the purge migration zeroes every fuel column, in every table
//   2. no endpoint will accept fuel as an input
//   3. a full game tick never puts any back
//
// Run: npm run sim:fuel
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let bad = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`PASS  ${label}`); return; }
  bad += 1;
  console.log(`FAIL  ${label}`);
  if (detail) console.log(`        ${detail}`);
}

// Every fuel-bearing column in the schema, as (table, columns).
const FUEL_COLUMNS = [
  ['game_factions', ['fuel']],
  ['game_ships', ['fuel', 'fuel_max', 'cargo_fuel']],
  ['game_bodies', ['yield_fuel']],
  ['game_settlements', ['stockpile_fuel']],
  ['game_trade_routes', ['cargo_fuel', 'per_run_fuel']],
  ['game_trade_route_ships', ['cargo_fuel']],
  ['trade_offers', ['offer_fuel', 'request_fuel']],
  ['trade_deliveries', ['fuel']],
  ['trade_agreements', ['a_fuel', 'b_fuel']],
];

function makeState() {
  const kv = new Map();
  return {
    storage: {
      get: async (k) => kv.get(k), put: async (k, v) => { kv.set(k, v); },
      delete: async (k) => kv.delete(k), setAlarm: async () => {},
      getAlarm: async () => null,
    },
    id: { toString: () => 'sim-room' },
    acceptWebSocket: () => {}, getWebSockets: () => [],
  };
}

async function callRoute(env, routes, method, path, userId, body) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = path.match(r.pattern);
    if (!m) continue;
    const res = await r.handle({ json: async () => body, headers: new Map() }, env, {
      url: new URL(`https://x${path}`), params: m.groups ?? {}, session: { user_id: userId },
    });
    return JSON.parse(await res.text());
  }
  throw new Error(`no route matched ${method} ${path}`);
}

const DB = new SimD1(':memory:');
const G = 'fuelpurge01';
const env = {
  DB,
  ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) },
};

// ------------------------------------------------------------------
// Seed a game the way the schema did BEFORE the purge: apply every
// migration except the purge itself, dirty the fuel columns, then let
// the purge run. That is the real upgrade path for a live game — the
// only one that matters, since a fresh game never had fuel to begin
// with.
// ------------------------------------------------------------------
const upToPurge = MIGRATIONS.filter(m => !/purge_fuel/.test(m.name ?? m.id ?? ''));
const purgeOnly = MIGRATIONS.filter(m => /purge_fuel/.test(m.name ?? m.id ?? ''));
check('the purge migration is in the bundle', purgeOnly.length === 1,
  JSON.stringify(MIGRATIONS.map(m => m.name ?? m.id).slice(-4)));

DB.applyMigrations(upToPurge);

await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                  VALUES ('uA','a@t','A','x',0), ('uB','b@t','B','x',0)`).run();
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at)
                  VALUES (?, 'Fuel Purge','uA',0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
                  VALUES (?, 'setup','purge',0,3600000,0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body)
                  VALUES (?,?,0,'earth'), (?,?,1,'luna')`).bind(G,'uA',G,'uB').run();

const factions = await import('../worker/factions.js');
await factions.seedGameWorld(env, G);
await DB.prepare("UPDATE games SET status='active' WHERE id = ?").bind(G).run();

const [A, B] = (await DB.prepare(
  'SELECT id, user_id, capital_body_id FROM game_factions WHERE game_id = ? ORDER BY slot')
  .bind(G).all()).results;

// DIRTY EVERY COLUMN. This is the state a long-running game is in.
await DB.prepare('UPDATE game_factions SET fuel = 500 WHERE game_id = ?').bind(G).run();
await DB.prepare('UPDATE game_bodies SET yield_fuel = 7 WHERE game_id = ?').bind(G).run();
await DB.prepare('UPDATE game_ships SET fuel = 99, fuel_max = 200, cargo_fuel = 42 WHERE game_id = ?')
  .bind(G).run();
await DB.prepare(
  `INSERT INTO game_settlements (id, game_id, body_id, owner_faction_id, type, name,
     hp, hp_max, population, surface_angle, created_at_tick, stockpile_fuel)
   VALUES ('st_fuel', ?, ?, ?, 'station', 'Depot', 100, 100, 1, 0, 0, 88)`)
  .bind(G, A.capital_body_id, A.id).run();
await DB.prepare(
  `INSERT INTO trade_offers (id, game_id, proposer_faction_id, responder_faction_id, status,
     offer_metal, offer_fuel, offer_gold, offer_science,
     request_metal, request_fuel, request_gold, request_science,
     created_at_tick, created_at_ms)
   VALUES ('of_fuel', ?, ?, ?, 'open', 0, 60, 0, 0, 0, 70, 0, 0, 0, 0)`)
  .bind(G, A.id, B.id).run();
await DB.prepare(
  `INSERT INTO trade_agreements (id, game_id, faction_a_id, faction_b_id, status,
     a_metal, a_fuel, a_gold, a_science, b_metal, b_fuel, b_gold, b_science,
     created_at_tick, created_at_ms)
   VALUES ('ag_fuel', ?, ?, ?, 'active', 0, 30, 0, 0, 0, 40, 0, 0, 0, 0)`)
  .bind(G, A.id, B.id).run();
await DB.prepare(
  `INSERT INTO trade_deliveries (id, game_id, trade_id, sender_faction_id, recipient_faction_id,
     status, metal, fuel, gold, science)
   VALUES ('dl_fuel', ?, 'of_fuel', ?, ?, 'unassigned', 0, 25, 0, 0)`)
  .bind(G, A.id, B.id).run();
// A route needs a real hull (FKs are ON in the sim, as in D1).
const anyShip = (await DB.prepare(
  'SELECT id FROM game_ships WHERE game_id = ? LIMIT 1').bind(G).first())?.id ?? null;
await DB.prepare(
  `INSERT INTO game_trade_routes (id, game_id, owner_faction_id, kind, ship_id,
     origin_body_id, dest_body_id, status, created_at_tick, cargo_fuel, per_run_fuel)
   VALUES ('rt_fuel', ?, ?, 'logistics', ?, ?, ?, 'returning', 0, 13, 17)`)
  .bind(G, A.id, anyShip, A.capital_body_id, A.capital_body_id).run();
await DB.prepare(
  `INSERT INTO game_trade_route_ships (id, game_id, route_id, ship_id, role, next_stop_seq,
     cargo_fuel, added_at_tick)
   VALUES ('rs_fuel', ?, 'rt_fuel', ?, 'carrier', 0, 11, 0)`).bind(G, anyShip).run();
// game_trade_route_stops carries no fuel — a stop is a plan, not a
// hold. Asserting otherwise is what made the first draft of the purge
// migration reference a column that does not exist.

const totalFuel = async () => {
  let n = 0;
  const rows = [];
  for (const [table, cols] of FUEL_COLUMNS) {
    const sum = cols.map(c2 => `COALESCE(SUM(${c2}),0)`).join(' + ');
    const r = await DB.prepare(`SELECT ${sum} AS n FROM ${table}`).first();
    const v = Number(r?.n ?? 0);
    if (v !== 0) rows.push(`${table}=${v}`);
    n += v;
  }
  return { n, rows };
};

const before = await totalFuel();
check('the pre-purge database really is full of fuel', before.n > 0, JSON.stringify(before.rows));

// ------------------------------------------------------------------
// 1. THE PURGE
// ------------------------------------------------------------------
DB.applyMigrations(purgeOnly);
const after = await totalFuel();
check('after the purge, not one fuel column holds a non-zero value anywhere',
  after.n === 0, JSON.stringify(after.rows));

// Re-running must stay safe — every request re-applies the bundle.
DB.applyMigrations(purgeOnly);
DB.applyMigrations(purgeOnly);
const again = await totalFuel();
check('...and re-applying it changes nothing', again.n === 0, JSON.stringify(again.rows));

// ------------------------------------------------------------------
// 2. NO ENDPOINT ACCEPTS FUEL
// ------------------------------------------------------------------
const trades = (await import('../worker/trades.js')).routes;
await DB.prepare('UPDATE game_factions SET metal = 1000, gold = 1000 WHERE game_id = ?').bind(G).run();

const offered = await callRoute(env, trades, 'POST', `/api/games/${G}/trades`, 'uA', {
  responder_faction_id: B.id, offer: { fuel: 50 }, request: { gold: 10 },
});
check('an offer OF fuel is refused', !!offered.error, JSON.stringify(offered).slice(0, 160));

const requested = await callRoute(env, trades, 'POST', `/api/games/${G}/trades`, 'uA', {
  responder_faction_id: B.id, offer: { metal: 10 }, request: { fuel: 50 },
});
check('a request FOR fuel is refused too — you cannot ask for what nobody has',
  !!requested.error, JSON.stringify(requested).slice(0, 160));

// The same call without fuel must still work, or the guard is too wide.
const clean = await callRoute(env, trades, 'POST', `/api/games/${G}/trades`, 'uA', {
  responder_faction_id: B.id, offer: { metal: 10 }, request: { gold: 10 },
});
check('a normal metal-for-credits offer still goes through', !!clean.trade?.id,
  JSON.stringify(clean).slice(0, 160));

// The HOST GRANT endpoint was the last door left open: a stale client
// or a curl could re-seed a pool the purge had just emptied, and
// nothing in the UI would ever show the result again.
const actions = (await import('../worker/actions.js')).routes;
await DB.prepare("UPDATE rooms SET host_id = 'uA' WHERE id = ?").bind(G).run();
const granted = await callRoute(env, actions, 'POST', `/api/games/${G}/admin/grant`, 'uA', {
  faction_id: 'all', fuel: 9999, ore: 5,
});
const poolAfterGrant = await DB.prepare(
  'SELECT COALESCE(SUM(fuel),0) AS f, COALESCE(SUM(metal),0) AS m FROM game_factions WHERE game_id = ?')
  .bind(G).first();
check('a host CANNOT grant fuel back into the game',
  Number(poolAfterGrant?.f ?? 0) === 0,
  JSON.stringify({ granted, pool: poolAfterGrant }).slice(0, 200));
check('...while the rest of the same grant still lands',
  Number(poolAfterGrant?.m ?? 0) > 0, JSON.stringify(poolAfterGrant));

// ------------------------------------------------------------------
// 3. THE TICK NEVER PUTS ANY BACK
// ------------------------------------------------------------------
const { Room } = await import('../worker/room.js');
const room = new Room(makeState(), env);
room.broadcast = () => {};
for (let i = 1; i <= 40; i++) {
  await room.resolveTick(G, i);
  await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(i, G).run();
}
const ticked = await totalFuel();
check('forty ticks of a live game produce exactly zero fuel', ticked.n === 0,
  JSON.stringify(ticked.rows));

// Body yields are the one thing that could quietly restart production.
const y = await DB.prepare('SELECT COALESCE(SUM(yield_fuel),0) AS n FROM game_bodies').first();
check('...and no world is producing any', Number(y?.n ?? 0) === 0, JSON.stringify(y));

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
