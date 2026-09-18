// ============================================================
// WAR IS DECLARED, NOT ASSUMED.
//
// The commonest complaint about this game was that everyone starts at
// war, and they were right. Hostility was the ABSENCE of a treaty, so
// two fleets sharing an orbit on tick one opened fire on each other, and
// the only way out was to negotiate a non-aggression pact as a term
// inside a trade deal — which needs a willing counterparty.
//
// This drives the REAL resolveTick, because the question is not "does
// the predicate return false" but "does the server actually hold fire".
// Every previous bug in this area was the data being right and the
// behaviour being wrong.
//
// Run: node sim/warDeclared.mjs
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { hostilePairs, openWarBetween, pairKey } from '../worker/wars.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const broadcasts = [];
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
const store = new Map();
const state = {
  storage: {
    async get(k) { return store.get(k); },
    async put(k, v) { store.set(k, v); },
    async delete(k) { return store.delete(k); },
    async list() { return new Map(store); },
    async deleteAll() { store.clear(); },
    setAlarm() {}, getAlarm() { return null; },
  },
  blockConcurrencyWhile: async (f) => f(),
};

const G = 'simwar000001';
const now = Date.now();
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES ('uA','a@t','A','x',?)`).bind(now).run();
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES ('uB','b@t','B','x',?)`).bind(now).run();
await DB.prepare(`INSERT INTO rooms (id,name,host_id,status,max_players,created_at,updated_at) VALUES (?,'War Sim','uA','lobby',2,?,?)`).bind(G, now, now).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at) VALUES (?,'setup','warseed',0,3600000,?,?)`).bind(G, now, now).run();
for (const u of ['uA', 'uB']) {
  await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,?,?,?)`)
    .bind(G, u, now, u === 'uA' ? 'earth' : 'mars').run();
}
const factions = await import('../worker/factions.js');
await factions.seedGameWorld(env, G);
await DB.prepare("UPDATE games SET status = 'active' WHERE id = ?").bind(G).run();

const fx = (await DB.prepare('SELECT id, user_id FROM game_factions WHERE game_id = ? ORDER BY slot').bind(G).all()).results;
const FA = fx[0].id, FB = fx[1].id;
const earth = (await DB.prepare(`SELECT id FROM game_bodies WHERE game_id=? AND template_id='earth'`).bind(G).first()).id;

// Two armed hulls belonging to different empires, parked in the same
// orbit. Before the inversion this alone was a battle.
let n = 0;
const putShip = async (fid, hp) => {
  const id = `${G}:sim${n++}`;
  await DB.prepare(
    `INSERT INTO game_ships
       (id, game_id, owner_faction_id, name, ship_class, parent_body_id,
        orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch, orbit_direction,
        fuel, fuel_max, status, built_at_tick, hp, hp_max, damage_per_tick)
     VALUES (?, ?, ?, ?, 'destroyer', ?, 2, 2, 0, 0, 0, 1,
             999, 999, 'active', 0, ?, ?, 40)`,
  ).bind(id, G, fid, `Hull ${n}`, earth, hp, hp).run();
  return id;
};
const shipA = await putShip(FA, 500);
const shipB = await putShip(FB, 500);

const { Room } = await import('../worker/room.js');
const room = new Room({ ...state, broadcast: (m) => broadcasts.push(m) }, env);
const hpOf = async (id) => (await DB.prepare('SELECT hp FROM game_ships WHERE id = ?').bind(id).first()).hp;
const runTick = async (t) => {
  await room.resolveTick(G, t);
  await DB.prepare('UPDATE games SET current_tick = ? WHERE id = ?').bind(t, G).run();
};

// ---- PEACE IS THE DEFAULT -------------------------------------------
check('a brand new game has no wars in it', (await hostilePairs(env, G)).size === 0);
const beforeA = await hpOf(shipA), beforeB = await hpOf(shipB);
for (let t = 1; t <= 4; t++) await runTick(t);
const peaceA = await hpOf(shipA), peaceB = await hpOf(shipB);
check('two rival hulls sharing an orbit do NOT shoot at peace',
  peaceA === beforeA && peaceB === beforeB,
  `A ${beforeA}->${peaceA}, B ${beforeB}->${peaceB}`);
check('...and nothing was reported destroyed',
  !broadcasts.some(b => b.type === 'ships_destroyed'));

// ---- A DECLARATION STARTS THE SHOOTING ------------------------------
const warId = await openWarBetween(env, G, 5, FA, FB, 'declared');
check('the declaration opens a war', !!warId);
const pairs = await hostilePairs(env, G);
check('...and the pair reads hostile', pairs.has(pairKey(FA, FB)), [...pairs].join(', '));

for (let t = 5; t <= 8; t++) await runTick(t);
const warA = await hpOf(shipA), warB = await hpOf(shipB);
check('once war is declared the same two hulls DO shoot',
  warA < peaceA && warB < peaceB, `A ${peaceA}->${warA}, B ${peaceB}->${warB}`);

// ---- AND ENDING IT STOPS THE SHOOTING -------------------------------
await DB.prepare('UPDATE game_wars SET ended_at_tick = 9, ended_by = ? WHERE id = ?').bind(FA, warId).run();
check('ending the war clears the pair', (await hostilePairs(env, G)).size === 0);
const ceaseA = await hpOf(shipA), ceaseB = await hpOf(shipB);
for (let t = 9; t <= 12; t++) await runTick(t);
check('a ceasefire actually stops the damage',
  (await hpOf(shipA)) === ceaseA && (await hpOf(shipB)) === ceaseB,
  `A ${ceaseA}->${await hpOf(shipA)}, B ${ceaseB}->${await hpOf(shipB)}`);

// ---- ONE OPEN WAR PER PAIR ------------------------------------------
await openWarBetween(env, G, 13, FA, FB, 'declared');
const again = await openWarBetween(env, G, 13, FB, FA, 'declared');
check('declaring twice does not open a second war', again === null);
check('...and the pair order does not matter',
  (await hostilePairs(env, G)).has(pairKey(FA, FB)));
const openCount = (await DB.prepare(
  'SELECT COUNT(*) AS c FROM game_wars WHERE game_id = ? AND ended_at_tick IS NULL').bind(G).first()).c;
check('exactly one war row is open', openCount === 1, String(openCount));

// ---- THE CLIENT AGREES WITH THE SERVER ------------------------------
// peace.ts is fed warPairs now, not pactPairs, and returns the same
// answer inverted. A UI that disagrees paints ceasefires that never
// happen, which is the bug its own header was written about.
const clientSrc = (await import('node:fs')).readFileSync(
  new URL('../src/game/peace.ts', import.meta.url), 'utf8');
check('the client predicate is built from the wars',
  /makePeaceCheck\(warPairs\?: readonly string\[\]\)/.test(clientSrc)
  && /return \(a, b\) => !set\.has\(pairKey\(a, b\)\)/.test(clientSrc));
check('...and no data now means peace, not universal hostility',
  /if \(!warPairs \|\| warPairs\.length === 0\) return ALWAYS_PEACE;/.test(clientSrc));
const groupingSrc = (await import('node:fs')).readFileSync(
  new URL('../src/game/systemGrouping.ts', import.meta.url), 'utf8');
check('a missing check defaults to peace everywhere it is optional',
  !/= NO_PEACE,/.test(groupingSrc));

console.log(bad === 0 ? '\nALL WAR-DECLARATION CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
