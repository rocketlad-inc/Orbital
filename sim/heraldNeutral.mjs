// ============================================================
// HERALD NEUTRALITY — a razed world stops being anyone's on the strip.
//
// "The game feed shows the Core and Earth as being under your control
// for some reason while they're being fought over." The game had
// already neutralised those worlds (body owner cleared when the last
// living settlement died); the Herald's territory strip fell back to
// the FIRST settlement row on the body, with no destroyed filter, and
// credited a settlement razed 170 ticks earlier.
//
// Drives the real sweep in room.js resolveTick and the real
// buildTerritoryData in heraldStrip.js.
//
// Run: node sim/heraldNeutral.mjs
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

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
const G = 'gheraldn';
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at)
                  VALUES ('uA','a@t','A','x',0), ('uB','b@t','B','x',0)`).run();
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?, 'Herald Test','uA',0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at)
                  VALUES (?, 'setup','herald-seed',0,3600000,0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body)
                  VALUES (?,?,0,'earth'), (?,?,1,'venus')`).bind(G, 'uA', G, 'uB').run();
const factions = await import('../worker/factions.js');
await factions.seedGameWorld(env, G);
await DB.prepare("UPDATE games SET status='active' WHERE id = ?").bind(G).run();
const [A, B] = (await DB.prepare(
  `SELECT id, capital_body_id FROM game_factions WHERE game_id = ? ORDER BY slot`).bind(G).all()).results;
await DB.prepare('DELETE FROM game_ships WHERE game_id = ?').bind(G).run();

const { Room } = await import('../worker/room.js');
const room = new Room(makeState(), env);
room.broadcast = () => {};
const { buildTerritoryData } = await import('../worker/heraldStrip.js');
let tickNow = 0;
const tick = async () => { tickNow += 1; await room.resolveTick(G, tickNow); await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(tickNow, G).run(); };

const MARS = `${G}:mars`;
const stripOwnerOf = async (bodyId) => {
  const d = await buildTerritoryData(env, G);
  // Sectors carry heliocentric bodies; moons ride on their planet.
  for (const sec of d.sectors ?? []) {
    for (const b of sec.bodies ?? []) if (b.id === bodyId || b.name === 'Mars') return b.owner ?? null;
  }
  return undefined;
};

// A settles Mars. Body owner follows; the strip shows A.
await DB.prepare(
  `INSERT INTO game_settlements (id, game_id, body_id, owner_faction_id, type, name, hp, hp_max, population, surface_angle, created_at_tick)
   VALUES ('st_a_mars', ?, ?, ?, 'station', 'A Mars', 100, 100, 1, 0, 0)`).bind(G, MARS, A.id).run();
await DB.prepare('UPDATE game_bodies SET owner_faction_id = ? WHERE id = ?').bind(A.id, MARS).run();
await tick();
check('strip credits the living owner', (await stripOwnerOf(MARS)) === A.id, String(await stripOwnerOf(MARS)));

// A's station is razed. The sweep clears the body; the strip must go neutral.
await DB.prepare('UPDATE game_settlements SET destroyed_at_tick = ? WHERE id = ?').bind(tickNow, 'st_a_mars').run();
await tick();
const bodyOwner = (await DB.prepare('SELECT owner_faction_id FROM game_bodies WHERE id = ?').bind(MARS).first())?.owner_faction_id;
check('the game neutralises the world (body owner cleared)', bodyOwner == null, String(bodyOwner));
check('the strip shows it as nobody\'s — not the razed settlement\'s old owner',
  (await stripOwnerOf(MARS)) === null, String(await stripOwnerOf(MARS)));

// B lands. Before the sweep runs, the strip still answers from living
// settlements only — and it is B, not A's ghost.
await DB.prepare(
  `INSERT INTO game_settlements (id, game_id, body_id, owner_faction_id, type, name, hp, hp_max, population, surface_angle, created_at_tick)
   VALUES ('st_b_mars', ?, ?, ?, 'station', 'B Mars', 100, 100, 1, 0, ?)`).bind(G, MARS, B.id, tickNow).run();
check('a fresh settler is credited from living rows before the sweep', (await stripOwnerOf(MARS)) === B.id, String(await stripOwnerOf(MARS)));

// Both present, one each: contested — nobody, rather than whoever sorted first.
await DB.prepare(
  `INSERT INTO game_settlements (id, game_id, body_id, owner_faction_id, type, name, hp, hp_max, population, surface_angle, created_at_tick)
   VALUES ('st_a2_mars', ?, ?, ?, 'station', 'A Mars 2', 100, 100, 1, 0, ?)`).bind(G, MARS, A.id, tickNow).run();
await DB.prepare('UPDATE game_bodies SET owner_faction_id = NULL WHERE id = ?').bind(MARS).run();
check('two factions with living settlements and no resolved owner: neutral, not first-row',
  (await stripOwnerOf(MARS)) === null, String(await stripOwnerOf(MARS)));

console.log(bad === 0 ? '\nALL HERALD-NEUTRALITY CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
