// ============================================================
// SHIP STATS KILLER — game_ship_stats credits ONE hull per kill.
//
// Combat resolves simultaneously, so every attacker that fired on a
// target in the tick it died "contributed". The per-hull ledger used to
// credit kills / overkill / low_hp_kills to ALL of them: on prod a
// corvette with 1 real kill read 24, and an empire that lost 113 hulls
// read 7,502 kills. The authoritative killer is the top-damage attacker
// ship (the one veterancy and battle_participants.killer_ship_id name).
//
// This drives the REAL resolveTick: two attackers (a heavy hitter at
// 20% HP, a light one at full HP) finish one defender together. Only the
// heavy hitter may be credited; shots / hits / damage stay per-shooter.
//
// Run: node sim/shipStatsKiller.mjs
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
const G = 'gstatskill1';
const now = Date.now();
for (const u of ['u1', 'u2']) {
  await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,'x',?)`)
    .bind(u, `${u}@t`, u, now).run();
}
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?,'Kill','u1',?,?)`).bind(G, now, now).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at) VALUES (?,'setup','kill',50,3600000,?,?)`).bind(G, now, now).run();
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,'u1',?,'earth')`).bind(G, now).run();
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,'u2',?,'mars')`).bind(G, now).run();
const factions = await import('../worker/factions.js');
await factions.seedGameWorld(env, G);
await DB.prepare(`UPDATE games SET status='active' WHERE id=?`).bind(G).run();

const fA = (await DB.prepare(`SELECT id FROM game_factions WHERE game_id=? AND user_id='u1'`).bind(G).first()).id;
const fB = (await DB.prepare(`SELECT id FROM game_factions WHERE game_id=? AND user_id='u2'`).bind(G).first()).id;
const field = (await DB.prepare(`SELECT id FROM game_bodies WHERE game_id=? AND template_id='phobos'`).bind(G).first()).id;

await DB.prepare(
  `INSERT INTO game_wars (id, game_id, faction_a, faction_b, declared_by, declared_at_tick, origin)
   VALUES (?, ?, ?, ?, ?, 40, 'declared')`,
).bind(`${G}:war1`, G, fA, fB, fA).run();

const ship = (id, owner, name, hp, hpMax, dmg) => DB.prepare(
  `INSERT INTO game_ships
     (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
      orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
      fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick)
   VALUES (?,?,?,?,'frigate',?, 2,2,0,0,0,1, 99,99,'active',0, ?,?,?)`,
).bind(id, G, owner, name, field, hp, hpMax, dmg).run();

const HEAVY = `${G}:heavy`, LIGHT = `${G}:light`, VICTIM = `${G}:victim`;
// Heavy: top damage AND nearly dead (20/100) -> the Last Stand candidate.
await ship(HEAVY, fA, 'Heavy', 20, 100, 400);
// Light: full health, lands on the same target, but is NOT the killer.
await ship(LIGHT, fA, 'Light', 100, 100, 40);
// 400 + 40 landed on 100 HP: together they kill, and the heavy hitter is the killer.
await ship(VICTIM, fB, 'Victim', 100, 100, 1);

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

const victim = await DB.prepare(`SELECT status FROM game_ships WHERE id=?`).bind(VICTIM).first();
check('the victim died this tick', victim?.status === 'destroyed', String(victim?.status));

const stats = async (id) => DB.prepare(
  `SELECT shots, hits, damage_dealt, kills, overkill, low_hp_kills FROM game_ship_stats WHERE game_id=? AND ship_id=?`,
).bind(G, id).first();
const h = await stats(HEAVY), l = await stats(LIGHT);
console.log('        heavy', JSON.stringify(h), '\n        light', JSON.stringify(l));

check('both attackers fired and landed (the premise: two contributors)',
  (h?.hits ?? 0) >= 1 && (l?.hits ?? 0) >= 1, `heavy hits=${h?.hits} light hits=${l?.hits}`);
check('the top-damage hull is credited the kill', h?.kills === 1, String(h?.kills));
check('the other contributor is NOT credited a kill', l?.kills === 0, String(l?.kills));
check('Last Stand goes to the killer alone', h?.low_hp_kills === 1 && l?.low_hp_kills === 0,
  `heavy=${h?.low_hp_kills} light=${l?.low_hp_kills}`);
check('overkill lands on the killer, none on the bystander',
  (h?.overkill ?? 0) > 0 && l?.overkill === 0, `heavy=${h?.overkill} light=${l?.overkill}`);
check('damage accounting is still per shooter', (h?.damage_dealt ?? 0) > (l?.damage_dealt ?? 0) && (l?.damage_dealt ?? 0) > 0,
  `heavy=${h?.damage_dealt} light=${l?.damage_dealt}`);

// The ledger must agree with the authoritative source: one death, one kill.
const total = (await DB.prepare(`SELECT COALESCE(SUM(kills),0) AS k FROM game_ship_stats WHERE game_id=?`).bind(G).first()).k;
check('total hull kills == ships destroyed (1)', total === 1, String(total));

console.log(bad === 0 ? '\nALL SHIP-STATS KILLER CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
