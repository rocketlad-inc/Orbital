// ============================================================
// REVIVAL + ANNIHILATION — elimination is no longer one-way, and a war
// with nobody left in it ends.
//
// QA battle test, 2026-09-22:
//   - an eliminated empire founded a capital on Mars with its colony
//     ship and stayed 'eliminated' (Lorne: "Let a new settlement revive
//     them");
//   - all four empires were eliminated and the game sat 'active' at
//     T160 with no way to finish.
//
// Drives the REAL resolveTick in three fresh games:
//   A. B lost all ground earlier, then founds a new settlement → the tick
//      revives B and chronicles it.
//   B. every empire's ground falls, nobody has a colony ship → the game
//      completes as 'annihilation' with no winner.
//   C. same, but one empire still has a colony ship → the game stays
//      open, because that empire can come back.
//
// Run: node sim/revival.mjs
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

const factionsMod = await import('../worker/factions.js');
const { Room } = await import('../worker/room.js');

async function setup(G) {
  const DB = new SimD1(':memory:');
  DB.applyMigrations(MIGRATIONS);
  const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
  const now = Date.now();
  for (const u of ['u1', 'u2']) {
    await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,'x',?)`)
      .bind(u, `${u}@t`, u, now).run();
  }
  await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?,'Revive','u1',?,?)`).bind(G, now, now).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at) VALUES (?,'setup','revive',50,3600000,?,?)`).bind(G, now, now).run();
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,'u1',?,'earth')`).bind(G, now).run();
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,'u2',?,'mars')`).bind(G, now).run();
  await factionsMod.seedGameWorld(env, G);
  await DB.prepare(`UPDATE games SET status='active' WHERE id=?`).bind(G).run();
  const fA = (await DB.prepare(`SELECT id FROM game_factions WHERE game_id=? AND user_id='u1'`).bind(G).first()).id;
  const fB = (await DB.prepare(`SELECT id FROM game_factions WHERE game_id=? AND user_id='u2'`).bind(G).first()).id;
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
  const tick = async (t) => {
    try { await room.resolveTick(G, t); return null; } catch (e) { return e; }
  };
  return { DB, G, fA, fB, tick };
}

// Ground falls: every live settlement of `fid` is marked destroyed.
const raze = (DB, G, fid, atTick) => DB.prepare(
  `UPDATE game_settlements SET destroyed_at_tick=? WHERE game_id=? AND owner_faction_id=? AND destroyed_at_tick IS NULL`,
).bind(atTick, G, fid).run();
// ...and every colony ship with it (the way back).
const sinkColonyShips = (DB, G, fid) => DB.prepare(
  `UPDATE game_ships SET status='destroyed' WHERE game_id=? AND owner_faction_id=? AND ship_class='colony'`,
).bind(G, fid).run();
const statusOf = async (DB, fid) => (await DB.prepare(`SELECT status FROM game_factions WHERE id=?`).bind(fid).first()).status;

// ---------- A. revival ----------
{
  const { DB, G, fB, tick } = await setup('grevive1');
  await raze(DB, G, fB, 45);
  await DB.prepare(`UPDATE game_factions SET status='eliminated' WHERE id=?`).bind(fB).run();
  // Found a new settlement: a copy of one of B's fallen rows, alive, on
  // a new id — the shape the colony-ship found path writes.
  const old = await DB.prepare(`SELECT * FROM game_settlements WHERE game_id=? AND owner_faction_id=? LIMIT 1`).bind(G, fB).first();
  const row = { ...old, id: `${G}:newcity`, destroyed_at_tick: null, founded_at_tick: 50 };
  if (!('founded_at_tick' in old)) delete row.founded_at_tick;
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO game_settlements (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .bind(...cols.map(c => row[c])).run();

  const err = await tick(51);
  check('A: the tick resolves', err === null, err ? String(err.message).slice(0, 200) : '');
  check('A: founding a settlement revives the eliminated empire', (await statusOf(DB, fB)) === 'active', await statusOf(DB, fB));
  const chron = await DB.prepare(`SELECT COUNT(*) AS n FROM chronicle_entries WHERE game_id=? AND kind='faction_revived' AND actor_faction_id=?`).bind(G, fB).first();
  check('A: the return is chronicled for the Herald', chron.n === 1, `${chron.n} rows`);
  const g = await DB.prepare(`SELECT status FROM games WHERE id=?`).bind(G).first();
  check('A: the game carries on', g.status === 'active', g.status);
}

// ---------- B. annihilation ----------
{
  const { DB, G, fA, fB, tick } = await setup('grevive2');
  for (const f of [fA, fB]) { await raze(DB, G, f, 50); await sinkColonyShips(DB, G, f); }
  const err = await tick(51);
  check('B: the tick resolves', err === null, err ? String(err.message).slice(0, 200) : '');
  check('B: both empires are eliminated', (await statusOf(DB, fA)) === 'eliminated' && (await statusOf(DB, fB)) === 'eliminated');
  const g = await DB.prepare(`SELECT status, victory_type, winner_faction_id FROM games WHERE id=?`).bind(G).first();
  check('B: a war with no empire left in it ENDS', g.status === 'completed', JSON.stringify(g));
  check('B: ...as annihilation, with no winner', g.victory_type === 'annihilation' && g.winner_faction_id == null, JSON.stringify(g));
}

// ---------- C. someone can still come back ----------
{
  const { DB, G, fA, fB, tick } = await setup('grevive3');
  await raze(DB, G, fA, 50); await sinkColonyShips(DB, G, fA);
  await raze(DB, G, fB, 50);
  const colony = await DB.prepare(`SELECT COUNT(*) AS n FROM game_ships WHERE owner_faction_id=? AND ship_class='colony' AND status='active'`).bind(fB).first();
  if (colony.n === 0) {
    // The seed may not hand out a colony ship; give B one.
    const any = await DB.prepare(`SELECT * FROM game_ships WHERE owner_faction_id=? LIMIT 1`).bind(fB).first();
    const row = { ...any, id: `${G}:ark`, ship_class: 'colony', status: 'active', name: 'Ark', fleet_id: null, captain_id: null };
    const cols = Object.keys(row);
    await DB.prepare(`INSERT INTO game_ships (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(...cols.map(c => row[c])).run();
  }
  const err = await tick(51);
  check('C: the tick resolves', err === null, err ? String(err.message).slice(0, 200) : '');
  const g = await DB.prepare(`SELECT status FROM games WHERE id=?`).bind(G).first();
  check('C: an empire with a colony ship can return, so the game stays open', g.status === 'active', g.status);
}

console.log(bad === 0 ? '\nALL REVIVAL CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
