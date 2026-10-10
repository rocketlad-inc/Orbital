// ============================================================
// The Mobile Foundry builds ships (2026-10-09).
//
// Léo Freitas (UBGE): "the mobile shipyard is broken, no built ships are
// spawning". Not one foundry-built hull ever launched in that game: the
// completion pass demanded a SETTLEMENT at the body, so every order laid
// down at a foundry over a world he had not settled was cancelled on the
// tick it should have rolled out, and kept its price. He also asked
// whether it builds 4 or 5 (the card says 4; the queue took 5) and what
// happens to builds when the foundry moves on.
//
// Drives the REAL queue endpoint and the REAL room.js resolveTick:
//   1. a foundry alone over a world gives exactly 4 slots
//   2. what it lays down launches THERE
//   3. moved on: hulls already on the ways still finish where laid down
//      (its card's promise); orders still waiting are refunded in full
//
// Run: npm run sim:foundry
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
    return await r.handle(req, env, { url: new URL(`https://x${path}`), params: m.groups ?? {}, session: { user_id: userId } });
  }
  throw new Error(`no route matched ${method} ${path}`);
}

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
const G = 'gfoundry';
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                  VALUES ('uA','a@t','A','x',0), ('uB','b@t','B','x',0)`).run();
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?, 'Foundry','uA',0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
                  VALUES (?, 'setup','foundry-seed',0,3600000,0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body)
                  VALUES (?,?,0,'earth'), (?,?,1,'luna')`).bind(G, 'uA', G, 'uB').run();
const factions = await import('../worker/factions.js');
await factions.seedGameWorld(env, G);
await DB.prepare("UPDATE games SET status='active', gating_enabled = 0 WHERE id = ?").bind(G).run();
const A = await DB.prepare(`SELECT id, capital_body_id FROM game_factions WHERE game_id = ? AND user_id = 'uA'`).bind(G).first();
const MARS = (await DB.prepare(`SELECT id FROM game_bodies WHERE game_id = ? AND id LIKE '%mars'`).bind(G).first()).id;
await DB.prepare(`UPDATE game_factions SET metal = 100000, gold = 100000 WHERE id = ?`).bind(A.id).run();
await DB.prepare(`DELETE FROM game_settlements WHERE game_id = ? AND body_id = ?`).bind(G, MARS).run();
await DB.prepare(
  `INSERT INTO game_ships (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
     orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
     fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick)
   VALUES ('forge', ?, ?, 'Forge', 'mobile_foundry', ?, 9, 9, 0, 0, 0, 1, 999, 999, 'active', 0, 900, 900, 0)`,
).bind(G, A.id, MARS).run();

const { routes } = await import('../worker/actions.js');
const { Room } = await import('../worker/room.js');
const room = new Room(makeState(), env);
room.broadcast = () => {};
let t = 0;
const tickTo = async (n) => {
  while (t < n) { t += 1; await room.resolveTick(G, t); await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(t, G).run(); }
};
const queue = async (name) => {
  const res = await callRoute(env, routes, 'POST', `/api/games/${G}/bodies/${MARS}/build`, 'uA', { ship_class: 'corvette', ship_name: name });
  return { status: res.status, body: JSON.parse(await res.text()) };
};
const orders = async () => (await DB.prepare(
  `SELECT ship_name, status, cancelled_at_tick FROM game_body_build_queue WHERE game_id = ? AND body_id = ? ORDER BY queued_at_tick, id`,
).bind(G, MARS).all()).results;
const shipsAtMars = async () => (await DB.prepare(
  `SELECT name FROM game_ships WHERE game_id = ? AND parent_body_id = ? AND ship_class = 'corvette' AND status = 'active'`,
).bind(G, MARS).all()).results.map(r => r.name).sort();
const pool = async () => DB.prepare('SELECT metal, gold FROM game_factions WHERE id = ?').bind(A.id).first();

// ---- 1. Four slots, as the card says ---------------------------------
for (const n of ['C1', 'C2', 'C3', 'C4', 'C5']) {
  const r = await queue(n);
  if (r.status >= 300) check(`queue ${n} at the foundry`, false, JSON.stringify(r));
}
const o1 = await orders();
check('a foundry alone over a world: 4 on the ways, the 5th waits',
  o1.filter(o => o.status === 'building').length === 4 && o1.filter(o => o.status === 'waiting').length === 1,
  JSON.stringify(o1));

// ---- 2. What it lays down launches there ------------------------------
await tickTo(30);
const built = await shipsAtMars();
check('the foundry\'s hulls launch at Mars (none were ever built before)',
  ['C1', 'C2', 'C3', 'C4', 'C5'].every(n => built.includes(n)), JSON.stringify({ built, orders: await orders() }));

// ---- 3. Moved on mid-build ----------------------------------------------
for (const n of ['D1', 'D2', 'D3', 'D4', 'D5']) await queue(n);
const before = await pool();
await DB.prepare(`UPDATE game_ships SET parent_body_id = ? WHERE id = 'forge'`).bind(A.capital_body_id).run();
await tickTo(31);
const after = await pool();
const d5 = (await orders()).find(o => o.ship_name === 'D5');
check('the order still waiting when the foundry left is cancelled...', d5?.cancelled_at_tick === 31, JSON.stringify(d5));
// Income moves the pool too: the next tick, with nothing refunded, is the
// baseline, and what is left over must be exactly what D5 was charged.
const ledger = JSON.parse((await DB.prepare(
  `SELECT charge_json FROM game_body_build_queue WHERE game_id = ? AND ship_name = 'D5'`).bind(G).first()).charge_json);
await tickTo(32);
const next = await pool();
const refundMetal = (after.metal - before.metal) - (next.metal - after.metal);
const refundGold = (after.gold - before.gold) - (next.gold - after.gold);
// Income itself drifts by a couple of units a tick as hulls build, hence
// the slack; a corvette costs 12/11, so a missing refund cannot pass.
check('...and refunded what it was charged',
  Math.abs(refundMetal - ledger.pool.metal) <= 3 && Math.abs(refundGold - ledger.pool.gold) <= 3
  && (ledger.pool.metal + ledger.pool.gold) > 0,
  JSON.stringify({ refundMetal, refundGold, charged: ledger.pool }));
await tickTo(60);
const finished = await shipsAtMars();
check('hulls already on the ways finish where they were laid down',
  ['D1', 'D2', 'D3', 'D4'].every(n => finished.includes(n)), JSON.stringify({ finished, orders: await orders() }));
check('no hull from the refunded order', !finished.includes('D5'));

console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
