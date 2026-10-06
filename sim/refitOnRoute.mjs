// ============================================================
// A refit lands on a freighter that never stops -- drives the REAL tick.
//
// CMDR Poopypants (Discord), 2026-10-06: "This freighter went to two
// different friendly worlds and never got refitted to a miner." It was
// flying a Mercury <-> Venus supply route. The refit pass ran once per
// tick, BEFORE arrivals, and only for hulls with no committed or
// in-transit node -- and a route freighter lands and is launched again
// inside the same tick, so it was never parked when the pass looked.
// 6 of the 8 pending refits on prod were on routes.
//
// Run: npm run sim:refitroute
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

function makeState() {
  const kv = new Map();
  return {
    storage: {
      get: async (k) => kv.get(k), put: async (k, v) => { kv.set(k, v); },
      delete: async (k) => kv.delete(k), setAlarm: async () => {}, getAlarm: async () => null,
    },
    id: { toString: () => 'sim-room' }, acceptWebSocket: () => {}, getWebSockets: () => [],
  };
}

async function callRoute(env, routes, method, path, userId, body) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = path.match(r.pattern);
    if (!m) continue;
    const req = { json: async () => body, headers: new Map() };
    const res = await r.handle(req, env, {
      url: new URL(`https://x${path}`), params: m.groups ?? {}, session: { user_id: userId },
    });
    return JSON.parse(await res.text());
  }
  throw new Error(`no route matched ${method} ${path}`);
}

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
const G = 'grefit1';
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                  VALUES ('uA','a@t','A','x',0), ('uB','b@t','B','x',0)`).run();
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?, 'Refit','uA',0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
                  VALUES (?, 'setup','refit-seed',0,3600000,0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body)
                  VALUES (?,?,0,'earth'), (?,?,1,'mars')`).bind(G, 'uA', G, 'uB').run();
const factions = await import('../worker/factions.js');
await factions.seedGameWorld(env, G);
await DB.prepare("UPDATE games SET status='active', gating_enabled = 0 WHERE id = ?").bind(G).run();
const [A] = (await DB.prepare(
  'SELECT id, user_id, capital_body_id FROM game_factions WHERE game_id = ? ORDER BY slot').bind(G).all()).results;
await DB.prepare('DELETE FROM game_ships WHERE game_id = ?').bind(G).run();
await DB.prepare('UPDATE game_factions SET metal = 5000, gold = 5000 WHERE game_id = ?').bind(G).run();

// A second world of A's: a station on Luna, next door to the capital.
const LUNA = `${G}:luna`;
{
  const src = await DB.prepare('SELECT id FROM game_settlements WHERE game_id = ? AND owner_faction_id = ? LIMIT 1')
    .bind(G, A.id).first();
  const cols = (await DB.prepare('PRAGMA table_info(game_settlements)').all()).results.map(x => x.name);
  const over = { id: "'st_luna'", body_id: `'${LUNA}'`, type: "'station'", destroyed_at_tick: 'NULL' };
  await DB.prepare(`INSERT INTO game_settlements (${cols.join(', ')})
                    SELECT ${cols.map(c => over[c] ?? c).join(', ')} FROM game_settlements WHERE id = ?`).bind(src.id).run();
}
await DB.prepare('UPDATE game_bodies SET terraformed_at_tick = 0 WHERE id = ?').bind(LUNA).run();
await DB.prepare(
  `INSERT INTO game_ships
    (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
     orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
     fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick, parts_json)
   VALUES ('ship_lev1', ?, ?, 'The Rotten Leviathan', 'freighter', ?, 2, 2, 0, 0, 0, 1,
           999, 999, 'active', 0, 60, 60, 0, '["engine"]')`,
).bind(G, A.id, A.capital_body_id).run();
await DB.prepare(
  `INSERT INTO game_ship_designs (id, game_id, faction_id, ship_class, name, parts_json, icon_variant, created_at_ms)
   VALUES ('dsn_scrap', ?, ?, 'freighter', 'Scrapper', '["mining"]', 'C', 0)`,
).bind(G, A.id).run();

const { Room } = await import('../worker/room.js');
const room = new Room(makeState(), env);
room.broadcast = () => {};
const v2 = (await import('../worker/tradeRoutesV2.js')).routes;
let tickNow = 0;
const tick = async (n = 1) => {
  for (let i = 0; i < n; i++) {
    tickNow += 1;
    await room.resolveTick(G, tickNow);
    await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(tickNow, G).run();
  }
};
const ship = () => DB.prepare(
  "SELECT parts_json, icon_variant, refit_pending_design_id FROM game_ships WHERE id = 'ship_lev1'").first();

// Put it on a route between its two worlds and let it get going.
const res = await callRoute(env, v2, 'POST', `/api/games/${G}/trade-routes/full`, 'uA', {
  name: 'Milk run',
  stops: [{ body_id: A.capital_body_id, action: 'pickup' }, { body_id: LUNA, action: 'dropoff' }],
  carrier_ship_ids: ['ship_lev1'],
});
check('the route is laid', !!res.ok, JSON.stringify(res).slice(0, 200));
await tick(3);
const flying = await DB.prepare(
  "SELECT 1 AS x FROM game_ship_nodes WHERE ship_id = 'ship_lev1' AND status IN ('committed','in_transit')").first();
check('precondition: the freighter is flying its route', !!flying);

// Order the refit mid-route, as the player did.
await DB.prepare("UPDATE game_ships SET refit_pending_design_id = 'dsn_scrap' WHERE id = 'ship_lev1'").run();

// Watch it for a while; it lands at one of its worlds every few ticks.
let landedAtHome = 0;
for (let i = 0; i < 40; i++) {
  await tick(1);
  const s = await ship();
  if (s.refit_pending_design_id == null) break;
  const parked = await DB.prepare(
    "SELECT parent_body_id FROM game_ships WHERE id = 'ship_lev1'").first();
  if (parked) landedAtHome += 1;
}
const s = await ship();
check('the refit is fitted while the freighter keeps flying its route',
  s.refit_pending_design_id == null && s.parts_json === '["mining"]', JSON.stringify(s));
check("the hull wears the design's look", s.icon_variant === 'C', JSON.stringify(s));
const r = await DB.prepare("SELECT status, cancelled_at_tick FROM game_trade_routes WHERE game_id = ?").bind(G).first();
check('and the route is still running', r?.cancelled_at_tick == null, JSON.stringify(r));

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
