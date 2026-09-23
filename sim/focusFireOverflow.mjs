// ============================================================
// FOCUS FIRE OVERFLOW — a big fleet must not waste itself on one hull.
//
// QA battle test, 2026-09-22: a 68-hull fleet (one fleet, one shared
// target seed) reached Mars with ~9,500 damage/tick against defenders of
// ~360 hp each. Every hull converged on the SAME frigate and held it
// until it died: ~96% overkill, exactly ONE kill per tick however big
// the fleet. 13 defenders took 13 ticks.
//
// This drives the REAL resolveTick: one attacking fleet of 40 captained
// hulls vs 10 defenders at one world, at war. Unfixed: 1 kill in the
// tick. Fixed: the surplus overflows to the next hull in the tier.
//
// Run: node sim/focusFireOverflow.mjs
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
const G = 'gfocusfire1';
const now = Date.now();
for (const u of ['u1', 'u2']) {
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,'x',?)`)
    .bind(u, `${u}@t`, u, now).run();
}
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?,'Focus','u1',?,?)`).bind(G, now, now).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at) VALUES (?,'setup','focus',50,3600000,?,?)`).bind(G, now, now).run();
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,'u1',?,'earth')`).bind(G, now).run();
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,'u2',?,'mars')`).bind(G, now).run();
const factions = await import('../worker/factions.js');
await factions.seedGameWorld(env, G);
await DB.prepare(`UPDATE games SET status='active' WHERE id=?`).bind(G).run();

const fA = (await DB.prepare(`SELECT id FROM game_factions WHERE game_id=? AND user_id='u1'`).bind(G).first()).id;
const fB = (await DB.prepare(`SELECT id FROM game_factions WHERE game_id=? AND user_id='u2'`).bind(G).first()).id;
const field = (await DB.prepare(`SELECT id FROM game_bodies WHERE game_id=? AND template_id='phobos'`).bind(G).first()).id;

// At war — peace is the default, so nothing shoots without this.
await DB.prepare(
  `INSERT INTO game_wars (id, game_id, faction_a, faction_b, declared_by, declared_at_tick, origin)
   VALUES (?, ?, ?, ?, ?, 40, 'declared')`,
).bind(`${G}:war1`, G, fA, fB, fA).run();

const ship = (id, owner, name, hp, dmg, fleetId, captainId) => DB.prepare(
  `INSERT INTO game_ships
     (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
      orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
      fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick, fleet_id, captain_id)
   VALUES (?,?,?,?,'frigate',?, 2,2,0,0,0,1, 99,99,'active',0, ?,?,?, ?, ?)`,
).bind(id, G, owner, name, field, hp, hp, dmg, fleetId, captainId).run();

// The attacking FLEET: 40 captained hulls sharing one fleet id, which is
// what makes them share a target seed (pickTarget) and converge.
const FLEET = `${G}:fleetA`;
const N_ATK = 40;
for (let i = 0; i < N_ATK; i++) {
  const sid = `${G}:atk${i}`, cid = `${G}:cap${i}`;
  await ship(sid, fA, `Striker ${i}`, 2000, 60, FLEET, cid);
  await DB.prepare(
    `INSERT INTO game_captains (id, game_id, faction_id, name, rank, traits_json, ship_id, status, created_at_tick)
     VALUES (?,?,?,?,0,'[]',?,'active',0)`,
  ).bind(cid, G, fA, `Captain ${i}`, sid).run();
}
await DB.prepare(
  `INSERT INTO game_fleets (id, game_id, faction_id, name, flag_captain_id, created_at_tick) VALUES (?,?,?,?,?,0)`,
).bind(FLEET, G, fA, 'Strike Group', `${G}:cap0`).run();

// Ten defenders, each far below what the fleet deals in one tick.
const N_DEF = 10;
for (let i = 0; i < N_DEF; i++) await ship(`${G}:def${i}`, fB, `Picket ${i}`, 100, 1, null, null);

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

let err = null;
try { await room.resolveTick(G, 51); } catch (e) { err = e; }
check('the tick resolves', err === null, err ? String(err.message).slice(0, 200) : '');

const fleetStill = (await DB.prepare(`SELECT COUNT(*) AS n FROM game_ships WHERE fleet_id=? AND status='active'`).bind(FLEET).first()).n;
check('the attackers are still one fleet (the premise: a shared seed)', fleetStill === N_ATK, String(fleetStill));

const dead = (await DB.prepare(
  `SELECT COUNT(*) AS n FROM game_ships WHERE owner_faction_id=? AND status='destroyed'`).bind(fB).first()).n;
const targets = (await DB.prepare(
  `SELECT COUNT(DISTINCT last_target_id) AS n FROM game_ships WHERE fleet_id=? AND last_target_id IS NOT NULL`).bind(FLEET).first()).n;
console.log(`        ${dead} of ${N_DEF} defenders destroyed in one tick; fleet spread over ${targets} targets`);
check('one tick of a 40-hull fleet kills MORE than one ship', dead > 1, `${dead} killed`);
check('...most of the ten, since the fleet deals ~24x their total HP', dead >= 7, `${dead} killed`);
check('the fleet spread its fire instead of all holding one hull', targets > 1, `${targets} target(s)`);

console.log(bad === 0 ? '\nALL FOCUS FIRE CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
