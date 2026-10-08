// ============================================================
// A weapons station shoots what is in its reach -- drives the REAL tick.
//
// Will (Discord), 2026-10-08: "why were my ships destroyed as they were
// leaving the planet?" Two corvettes leaving Pluto and Charon died at T81
// with no killer named. They had been shot by the Varda Ancient Battery,
// ~10,000 units away with a 700-unit reach. The station pass read a hull
// in flight as shipStateAt(...).x, but that returns { pos, vel }: the
// position was undefined, the distance NaN, and NaN never fails a range
// test -- so every armed hull in flight anywhere was "in range" of every
// weapons station (an ancient battery shoots everyone; an owned one,
// everyone its owner is at war with).
//
// Run: npm run sim:stationreach
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { orbitAngle } from '../worker/orbitPos.js';

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures++; if (detail !== undefined) console.log(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); }
}

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = {
  DB,
  ROOM: {
    idFromName: (n) => ({ toString: () => n }),
    get: () => ({
      fetch: async (url) => (String(url).includes('/settings')
        ? new Response(JSON.stringify({ tick_interval_ms: 3600000 }), { headers: { 'content-type': 'application/json' } })
        : new Response(null, { status: 204 })),
    }),
  },
};
const G = 'simroom00001';
const now = Date.now();
for (const i of [0, 1]) {
  await DB.prepare(`INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, 'x', ?)`)
    .bind(`u${i}`, `u${i}@example.invalid`, `P${i}`, now).run();
}
await DB.prepare(`INSERT INTO rooms (id, name, host_id, status, max_players, created_at, updated_at) VALUES (?, 'Reach', 'u0', 'in_progress', 2, ?, ?)`)
  .bind(G, now, now).run();
for (const i of [0, 1]) await DB.prepare('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)').bind(G, `u${i}`, now).run();
await DB.prepare(`INSERT INTO games (id, status, map_seed, current_tick, tick_interval_ms, created_at, started_at) VALUES (?, 'setup', 'reach-seed', 0, 3600000, ?, ?)`)
  .bind(G, now, now).run();
// Transit combat on, as on prod (cfg_transitlive).
await DB.prepare(`INSERT INTO game_configs (id, name, status, overrides, created_ms, updated_ms, published_ms) VALUES ('cfg_r', 'reach', 'published', ?, ?, ?, ?)`)
  .bind(JSON.stringify({ transit_combat_enabled: 1 }), now, now, now).run();
await DB.prepare(`UPDATE games SET config_id = 'cfg_r' WHERE id = ?`).bind(G).run();
(await import('../worker/gameConfig.js')).invalidate();
await (await import('../worker/factions.js')).seedGameWorld(env, G);
await DB.prepare(`UPDATE games SET status = 'active', gating_enabled = 0 WHERE id = ?`).bind(G).run();

const { Room } = await import('../worker/room.js');
const room = new Room({
  id: { toString: () => 'sim-room' },
  storage: { get: async () => undefined, put: async () => {}, delete: async () => {}, list: async () => new Map(), getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} },
  getWebSockets: () => [], acceptWebSocket: () => {}, blockConcurrencyWhile: async (fn) => fn(),
}, env);
room.broadcast = () => {};

// The battery's host: an ordinary circular-orbit world round the Sun
// that nobody lives on, as far out as possible from every capital.
const caps = new Set((await DB.prepare('SELECT capital_body_id c FROM game_factions WHERE game_id = ?').bind(G).all()).results.map(r => r.c));
const sol = (await DB.prepare(`SELECT id FROM game_bodies WHERE game_id = ? AND type = 'star' AND parent_body_id IS NULL`).bind(G).first()).id;
const host = (await DB.prepare(
  `SELECT id, name, orbit_radius, orbit_period, angle0 FROM game_bodies
    WHERE game_id = ? AND parent_body_id = ? AND type IN ('terrestrial','dwarf')
      AND orbit_rp IS NULL ORDER BY orbit_radius DESC`,
).bind(G, sol).all()).results.find(b => !caps.has(b.id));
const fa = await DB.prepare('SELECT id FROM game_factions WHERE game_id = ? ORDER BY slot LIMIT 1').bind(G).first();
const TICK = 50;
await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(TICK, G).run();
const bat = await room.spawnAncientStructure(G, { bodyId: host.id, bodyName: host.name, kind: 'weapons_station', discoverer: fa.id }, TICK - 1);
const batId = typeof bat === 'string' ? bat : (await DB.prepare(`SELECT body_id FROM game_megastructures WHERE game_id = ? AND ancient = 1`).bind(G).first()).body_id;
check(`an ancient battery stands at ${host.name}`, !!batId);

const ang = orbitAngle(host.angle0, host.orbit_period, TICK);
const hostAt = { x: Math.cos(ang) * host.orbit_radius, y: Math.sin(ang) * host.orbit_radius };

// One armed hull of fa's, put into flight at a chosen point.
const seed = await DB.prepare(`SELECT * FROM game_ships WHERE game_id = ? AND owner_faction_id = ? AND damage_per_tick > 0 LIMIT 1`).bind(G, fa.id).first();
if (!seed) throw new Error('no armed starting hull');
// Park every other hull at home and unarmed-irrelevant: only `seed` flies.
async function flyAt(p, label) {
  await DB.prepare(`DELETE FROM game_ship_nodes WHERE game_id = ?`).bind(G).run();
  await DB.prepare(`UPDATE game_megastructures SET last_target_id = NULL, last_combat_tick = NULL WHERE body_id = ?`).bind(batId).run();
  await DB.prepare(`UPDATE game_ships SET hp = hp_max, status = 'active', destroyed_at_tick = NULL, last_combat_tick = NULL WHERE id = ?`).bind(seed.id).run();
  // Launched this tick from p (torchStateAt returns the launch point at
  // t <= start), bound for its own home, a long way off.
  await DB.prepare(
    `INSERT INTO game_ship_nodes (id, game_id, ship_id, sequence, anchor_kind, target_body_id, scheduled_t,
                                  fuel_cost, status, committed_at_tick, arrival_at_tick,
                                  launch_x, launch_y, launch_vx, launch_vy, accel, flip_tick)
     VALUES (?, ?, ?, 0, 'absolute', ?, ?, 0, 'in_transit', ?, ?, ?, ?, 0, 0, 0.01, ?)`,
  ).bind(`n_${label}`, G, seed.id, seed.parent_body_id, TICK, TICK - 1, TICK + 40, p.x, p.y, TICK + 20).run();
  await room.resolveTick(G, TICK);
  return DB.prepare(`SELECT last_target_id t, last_combat_tick c FROM game_megastructures WHERE body_id = ?`).bind(batId).first();
}

// Far: the opposite side of the Sun from the battery.
const far = { x: -hostAt.x, y: -hostAt.y };
let r = await flyAt(far, 'far');
check(`a hull in flight ${Math.round(Math.hypot(far.x - hostAt.x, far.y - hostAt.y))} units away is NOT fired on`, r.t !== seed.id, r);

// Near: launched right beside the battery's world.
const near = { x: hostAt.x + 40, y: hostAt.y };
r = await flyAt(near, 'near');
check('a hull in flight inside the reach IS fired on', r.t === seed.id && r.c === TICK, r);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
