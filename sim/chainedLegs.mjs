// ============================================================
// Chained legs leave from where the ship IS (2026-10-09).
//
// Wil, UBGE T94-T104: a squadron's queued Io leg had been planned from
// Ganymede, then re-posted behind a new Europa leg unchanged. The depart
// pass flew any committed leg whose time had come, mid-flight or not,
// from its stored launch point: at T103 the squadron, still flying to
// Europa, took off for Io FROM GANYMEDE. "Teleported to base in the
// middle of the fight."
//
// Drives the REAL room.js resolveTick:
//   1. a leg waits while its hull is still flying an earlier one
//   2. a stale chained leg is re-planned from the world the hull lands on
//   3. a properly chained leg (timed within the tick) flies as stored
//   4. a first leg from open space (a mid-flight redirect) flies as stored
//   5. one leg per hull per tick
//
// Run: npm run sim:chain
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
    id: { toString: () => 'sim-room' },
    acceptWebSocket: () => {}, getWebSockets: () => [],
  };
}

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
const G = 'gchain';
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                  VALUES ('uA','a@t','A','x',0), ('uB','b@t','B','x',0)`).run();
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?, 'Chain','uA',0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
                  VALUES (?, 'setup','chain-seed',0,3600000,0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body)
                  VALUES (?,?,0,'earth'), (?,?,1,'luna')`).bind(G, 'uA', G, 'uB').run();
const factions = await import('../worker/factions.js');
await factions.seedGameWorld(env, G);
await DB.prepare("UPDATE games SET status='active' WHERE id = ?").bind(G).run();
const A = await DB.prepare(`SELECT id, capital_body_id FROM game_factions WHERE game_id = ? ORDER BY slot LIMIT 1`).bind(G).first();
await DB.prepare('DELETE FROM game_ships WHERE game_id = ?').bind(G).run();
const bodyId = async (name) => (await DB.prepare(`SELECT id FROM game_bodies WHERE game_id = ? AND (id = ? OR id LIKE ?)`)
  .bind(G, name, `%:${name}`).first())?.id;
const EARTH = A.capital_body_id, MARS = await bodyId('mars'), VENUS = await bodyId('venus'), JUPITER = await bodyId('jupiter');

for (const id of ['wil', 'legit', 'redirect', 'double']) {
  await DB.prepare(
    `INSERT INTO game_ships (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
       orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
       fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick)
     VALUES (?, ?, ?, ?, 'corvette', ?, 2, 2, 0, 0, 0, 1, 999, 999, 'active', 0, 40, 40, 0)`,
  ).bind(id, G, A.id, id, EARTH).run();
}
const { makeRouteMath } = await import('../worker/routeMath.js');
const { bodyPosAt } = makeRouteMath(DB, G);
const node = async (id, ship, seq, target, st, arr, status, launch) => DB.prepare(
  `INSERT INTO game_ship_nodes (id, game_id, ship_id, sequence, anchor_kind, target_body_id,
     scheduled_t, arrival_at_tick, dv_prograde, dv_normal, dv_radial, fuel_cost,
     launch_x, launch_y, launch_vx, launch_vy, accel, flip_tick, status, committed_at_tick)
   VALUES (?, ?, ?, ?, 'absolute', ?, ?, ?, 0, 0, 0, 0, ?, ?, 0, 0, 0.01, ?, ?, 0)`,
).bind(id, G, ship, seq, target, st, arr, launch?.x ?? null, launch?.y ?? null, (st + arr) / 2, status).run();

// 1+2. Wil's shape: flying Earth -> Mars (lands T10); a chained Venus leg
// timed for T5 and launching from EARTH (where the old route started).
await node('w1', 'wil', 0, MARS, 0, 10, 'in_transit', await bodyPosAt(EARTH, 0));
await node('w2', 'wil', 1, VENUS, 5, 20, 'committed', await bodyPosAt(EARTH, 5));
// 3. A properly chained leg: lands Mars at T10, leaves T9.6 from Mars.
await node('l1', 'legit', 0, MARS, 0, 10, 'in_transit', await bodyPosAt(EARTH, 0));
const legitLaunch = await bodyPosAt(MARS, 9.6);
await node('l2', 'legit', 1, VENUS, 9.6, 24, 'committed', legitLaunch);
// 4. A redirect mid-flight: a first leg launching from open space at T3.
const space = { x: 12345, y: -6789 };
await node('r1', 'redirect', 0, JUPITER, 3, 40, 'committed', space);
// 5. Two committed legs due the same tick for one hull.
await node('d1', 'double', 0, MARS, 2, 12, 'committed', await bodyPosAt(EARTH, 2));
await node('d2', 'double', 1, VENUS, 2, 15, 'committed', await bodyPosAt(EARTH, 2));

const { Room } = await import('../worker/room.js');
const room = new Room(makeState(), env);
room.broadcast = () => {};
const get = (id) => DB.prepare('SELECT * FROM game_ship_nodes WHERE id = ?').bind(id).first();
let t = 0;
const tickTo = async (n) => {
  while (t < n) {
    t += 1;
    await room.resolveTick(G, t);
    await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(t, G).run();
  }
};

await tickTo(3);
check('a redirect from open space departs as stored', (await get('r1')).status === 'in_transit'
  && Math.abs((await get('r1')).launch_x - space.x) < 1e-6, JSON.stringify(await get('r1')));
const d1 = await get('d1'), d2 = await get('d2');
check('two legs due at once: only the first takes off', d1.status === 'in_transit' && d2.status === 'committed',
  `${d1.status} / ${d2.status}`);

await tickTo(9);
check('the chained leg waits while its hull is still flying (T5..T9)', (await get('w2')).status === 'committed',
  (await get('w2')).status);
const flyingAtNine = (await DB.prepare(`SELECT COUNT(*) n FROM game_ship_nodes WHERE ship_id='wil' AND status='in_transit'`).first()).n;
check('never two legs in flight for one hull', flyingAtNine === 1, `in flight: ${flyingAtNine}`);

await tickTo(10);
const w2 = await get('w2');
const marsAt10 = await bodyPosAt(MARS, 10);
const earthAt10 = await bodyPosAt(EARTH, 10);
const dMars = Math.hypot(w2.launch_x - marsAt10.x, w2.launch_y - marsAt10.y);
const dEarth = Math.hypot(w2.launch_x - earthAt10.x, w2.launch_y - earthAt10.y);
check('on landing, the stale leg takes off', w2.status === 'in_transit', w2.status);
check('...re-planned from Mars, where the hull landed (not Earth)', dMars < 20 && dEarth > 50,
  `from Mars ${dMars.toFixed(1)}, from Earth ${dEarth.toFixed(1)}`);
check('...leaving now, arriving later', w2.scheduled_t === 10 && w2.arrival_at_tick > 10, `${w2.scheduled_t} -> ${w2.arrival_at_tick}`);
check('the hull is parked at Mars', (await DB.prepare(`SELECT parent_body_id p FROM game_ships WHERE id='wil'`).first()).p === MARS);

const l2 = await get('l2');
check('a properly chained leg flies exactly as planned', l2.status === 'in_transit'
  && Math.abs(l2.launch_x - legitLaunch.x) < 1e-6 && l2.scheduled_t === 9.6, JSON.stringify({ s: l2.status, st: l2.scheduled_t }));

await tickTo(13);
check('the second of the double departs once the first lands', (await get('d2')).status === 'in_transit', (await get('d2')).status);

console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
