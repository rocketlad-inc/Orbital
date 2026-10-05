// ============================================================
// "In combat" means a fight the player can see -- drives the REAL worker.
//
// Drt3yGrandma (Discord), 2026-10-03: "Getting a message saying two ships
// I'm trying to make a fleet out of are in combat (they're not)". Prod: 30
// such refusals from 6 players in five days. The lock keyed off two stamps
// only, and an unowned ancient battery stamps every armed hull it shoots
// at, war or no war, at range and mid-flight.
//
// Run: npm run sim:fleetlock
// ============================================================

import worker from '../worker/index.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures++; if (detail !== undefined) console.log(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); }
}

const ROOM = {
  idFromName: (n) => n,
  get: () => ({ async fetch(url) { const p = new URL(typeof url === 'string' ? url : url.url).pathname; return p === '/settings' ? Response.json({}) : Response.json({ ok: true }); } }),
};
const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
DB.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
for (const m of MIGRATIONS) DB.db.prepare('INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, 0)').run(m.name);
const env = { DB, ROOM, EMAIL_LINK_SECRET: 'sim-secret' };
const execCtx = { waitUntil() {}, passThroughOnException() {} };

async function call(method, path, { body, cookie } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  const res = await worker.fetch(new Request(`https://orbital-empire.com${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), env, execCtx);
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { data = text; }
  const sc = res.headers.get('set-cookie');
  return { status: res.status, data, cookie: sc ? sc.split(';')[0] : null };
}
async function signup(name) {
  const r = await call('POST', '/api/auth/signup', { body: { email: `${name.toLowerCase()}@example.com`, password: 'password123', display_name: name } });
  if (r.status !== 201) throw new Error(`signup ${name} -> ${r.status} ${JSON.stringify(r.data)}`);
  return { name, cookie: r.cookie, id: r.data.user.id };
}

/** Copy one row of `table`, overriding some columns (fills every NOT NULL). */
async function cloneRow(table, srcId, over) {
  const cols = (await DB.prepare(`PRAGMA table_info(${table})`).all()).results.map(x => x.name);
  const vals = [];
  const sel = cols.map(c => {
    if (!(c in over)) return c;
    vals.push(over[c]);
    return `?${vals.length + 1}`;
  }).join(', ');
  await DB.prepare(`INSERT INTO ${table} (${cols.join(', ')}) SELECT ${sel} FROM ${table} WHERE id = ?1`)
    .bind(srcId, ...vals).run();
}

const A = await signup('Grandma');
const B = await signup('Rival');
const c = await call('POST', '/api/rooms', { cookie: A.cookie, body: { name: 'Lock', max_players: 2 } });
const G = c.data.room.id;
await call('POST', `/api/rooms/${G}/join`, { cookie: B.cookie });
const s = await call('POST', `/api/lobby/rooms/${G}/start`, { cookie: A.cookie });
if (s.status !== 200) throw new Error(`start ${s.status} ${JSON.stringify(s.data)}`);
await DB.prepare(`UPDATE games SET status = 'active', gating_enabled = 0, current_tick = 50 WHERE id = ?`).bind(G).run();
const TICK = 50;
const fa = await DB.prepare('SELECT id, capital_body_id FROM game_factions WHERE game_id = ? AND user_id = ?').bind(G, A.id).first();
const fb = await DB.prepare('SELECT id FROM game_factions WHERE game_id = ? AND user_id = ?').bind(G, B.id).first();
const home = fa.capital_body_id;

// Three hulls of A's parked at home, each with its own captain.
const seed = await DB.prepare(`SELECT id FROM game_ships WHERE game_id = ? AND owner_faction_id = ? LIMIT 1`).bind(G, fa.id).first();
if (!seed) throw new Error('A has no starting ship to copy');
const capSeed = await DB.prepare(`SELECT id FROM game_captains WHERE game_id = ? LIMIT 1`).bind(G).first();
const ships = [];
for (const [i, nm] of ['Flag', 'Wing', 'Tail'].entries()) {
  const id = `${G}:sx${i}`;
  const cap = `${G}:cx${i}`;
  await cloneRow('game_ships', seed.id, {
    id, name: nm, owner_faction_id: fa.id, parent_body_id: home, status: 'active',
    fleet_id: null, captain_id: cap, last_combat_tick: null, last_damaged_tick: null, hp: 100,
  });
  if (capSeed) await cloneRow('game_captains', capSeed.id, { id: cap, faction_id: fa.id, ship_id: id, status: 'active' });
  else throw new Error('no captain row to copy');
  ships.push(id);
}
const [FLAG, WING, TAIL] = ships;

const form = () => call('POST', `/api/games/${G}/fleets`, {
  cookie: A.cookie, body: { ship_ids: [FLAG, WING], flag_ship_id: FLAG, name: 'Test' },
});
const disband = async () => {
  await DB.prepare(`UPDATE game_ships SET fleet_id = NULL WHERE game_id = ? AND owner_faction_id = ?`).bind(G, fa.id).run();
  await DB.prepare(`DELETE FROM game_fleets WHERE game_id = ?`).bind(G).run();
  // Put the captains back where they were.
  for (const [i, id] of ships.entries()) {
    await DB.prepare(`UPDATE game_ships SET captain_id = ? WHERE id = ?`).bind(`${G}:cx${i}`, id).run();
    await DB.prepare(`UPDATE game_captains SET ship_id = ? WHERE id = ?`).bind(id, `${G}:cx${i}`).run();
  }
};

// 1. The battery case: Wing was shot at this tick, nobody is at war.
await DB.prepare(`UPDATE game_ships SET last_combat_tick = ? WHERE id = ?`).bind(TICK, WING).run();
let r = await form();
check('a hull an ancient battery shot at, with no war on, can join a fleet', r.status === 201 || r.status === 200, [r.status, r.data]);
await disband();

// 2. A real fight: at war with B, and a B warship is parked at home.
await DB.prepare(`INSERT INTO game_wars (id, game_id, faction_a, faction_b, declared_by, declared_at_tick)
                  VALUES ('w1', ?, ?, ?, ?, 1)`).bind(G, fa.id < fb.id ? fa.id : fb.id, fa.id < fb.id ? fb.id : fa.id, fa.id).run();
await cloneRow('game_ships', seed.id, {
  id: `${G}:enemy`, name: 'Raider', owner_faction_id: fb.id, parent_body_id: home, status: 'active',
  fleet_id: null, captain_id: null, hp: 100,
});
r = await form();
check('a captained hull fighting an enemy at war at its world is locked', r.status === 409 && r.data?.error?.code === 'in_combat', [r.status, r.data]);

// 3. Same fight, but the joining hull has no captain to give up.
await DB.prepare(`UPDATE game_captains SET ship_id = NULL WHERE id = ?`).bind(`${G}:cx1`).run();
await DB.prepare(`UPDATE game_ships SET captain_id = NULL WHERE id = ?`).bind(WING).run();
r = await form();
check('an uncaptained hull can join mid-fight (no captain changes post)', r.status === 201 || r.status === 200, [r.status, r.data]);
await disband();

// 4. The enemy is there, but Wing is flying away (stamped by a pass).
await DB.prepare(`INSERT INTO game_ship_nodes (id, game_id, ship_id, sequence, anchor_kind, scheduled_t, fuel_cost,
                                              status, target_body_id, arrival_at_tick)
                  VALUES ('n1', ?, ?, 0, 'absolute', ?, 0, 'in_transit', ?, ?)`)
  .bind(G, WING, TICK - 1, home, TICK + 10).run();
r = await form();
check('a hull in flight is not "in combat" at the world it left', r.status === 201 || r.status === 200, [r.status, r.data]);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
