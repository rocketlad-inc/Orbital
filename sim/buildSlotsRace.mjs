// ============================================================
// Build slots hold when orders land together -- drives the REAL worker.
//
// Moitão (Discord), 2026-10-01: "it might be a new bug when you steal a
// planet you can build more ships than possible". On Callisto a captured
// station with no shipyard (1 slot) built four corvettes at once on the
// tick it changed hands, and the other side did the same twice.
//
// Not about capture: the build handler read "how many are building" and
// then inserted the order as two steps, so orders landing together all
// counted the same number and all started. A fresh capture just meant a
// player queueing a burst at an empty 1-slot yard.
//
// Fires a burst of orders concurrently and checks exactly `slots` start.
//
// Run: npm run sim:buildslots
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

const A = await signup('Moi');
const B = await signup('Leo');
const c = await call('POST', '/api/rooms', { cookie: A.cookie, body: { name: 'Slots', max_players: 2 } });
const G = c.data.room.id;
await call('POST', `/api/rooms/${G}/join`, { cookie: B.cookie });
const s = await call('POST', `/api/lobby/rooms/${G}/start`, { cookie: A.cookie });
if (s.status !== 200) throw new Error(`start ${s.status} ${JSON.stringify(s.data)}`);
await DB.prepare(`UPDATE games SET status = 'active', gating_enabled = 0 WHERE id = ?`).bind(G).run();
const fa = await DB.prepare('SELECT id, capital_body_id FROM game_factions WHERE game_id = ? AND user_id = ?').bind(G, A.id).first();
await DB.prepare('UPDATE game_factions SET metal = 100000, gold = 100000 WHERE id = ?').bind(fa.id).run();

/** The slots the yard really has, by the server's own rule. */
async function slotsAt(bodyId) {
  const rows = (await DB.prepare(
    `SELECT buildings_json FROM game_settlements WHERE game_id = ? AND body_id = ? AND owner_faction_id = ?
       AND type = 'station' AND destroyed_at_tick IS NULL`).bind(G, bodyId, fa.id).all()).results ?? [];
  let lv = 0;
  for (const r of rows) { try { lv += Number(JSON.parse(r.buildings_json || '{}').shipyard ?? 0) || 0; } catch { /* */ } }
  return 1 + lv;
}
const counts = async (bodyId) => {
  const rows = (await DB.prepare(
    `SELECT status, COUNT(*) n FROM game_body_build_queue WHERE game_id = ? AND body_id = ? AND faction_id = ?
       AND cancelled_at_tick IS NULL GROUP BY status`).bind(G, bodyId, fa.id).all()).results ?? [];
  return Object.fromEntries(rows.map(r => [r.status, r.n]));
};
const burst = (bodyId, n, tag) => Promise.all(Array.from({ length: n }, (_, i) =>
  call('POST', `/api/games/${G}/bodies/${encodeURIComponent(bodyId)}/build`, {
    cookie: A.cookie, body: { ship_class: 'corvette', ship_name: `${tag}${i}`, bare: true },
  })));

// ---- the case reported: a yard with ONE slot, a burst of four ------------------
const cap = fa.capital_body_id;
// Strip any shipyard so the capital is the reported shape: one slot.
await DB.prepare(`UPDATE game_settlements SET buildings_json = '{"lab":2}' WHERE game_id = ? AND body_id = ? AND type = 'station'`).bind(G, cap).run();
check('the yard has exactly one slot, like the captured station', (await slotsAt(cap)) === 1, await slotsAt(cap));
const r1 = await burst(cap, 4, 'K');
check('all four orders are accepted (and charged)', r1.every(r => r.status === 201), r1.map(r => [r.status, r.data?.error?.code]));
let q = await counts(cap);
check('ONE starts building; the other three wait', q.building === 1 && q.waiting === 3, q);
check('each answer says what actually happened to it',
  r1.filter(r => r.data?.order?.status === 'building').length === 1
  && r1.filter(r => r.data?.order?.status === 'waiting').length === 3, r1.map(r => r.data?.order?.status));
const ids = r1.map(r => r.data?.order?.id);
check('no two orders share an id', new Set(ids).size === ids.length, ids);

// ---- a bigger yard: the cap is the yard's, not one ----------------------------
await DB.prepare(`UPDATE game_body_build_queue SET cancelled_at_tick = 0 WHERE game_id = ?`).bind(G).run();
// A station with a level-2 shipyard: 1 + 2 = 3 slots. Copied from the
// capital's city row so every NOT NULL column is filled.
const cols = (await DB.prepare('PRAGMA table_info(game_settlements)').all()).results.map(x => x.name);
const pick = cols.map(x => (x === 'id' ? "'st_yard'" : x === 'type' ? "'station'" : x === 'buildings_json' ? `'{"shipyard":2}'` : x)).join(', ');
await DB.prepare(`INSERT INTO game_settlements (${cols.join(', ')}) SELECT ${pick} FROM game_settlements
                   WHERE game_id = ? AND body_id = ? AND owner_faction_id = ? LIMIT 1`).bind(G, cap, fa.id).run();
const slots3 = await slotsAt(cap);
check('the second yard really has three slots', slots3 === 3, slots3);
await burst(cap, slots3 + 3, 'B');
q = await counts(cap);
check(`a ${slots3}-slot yard starts exactly ${slots3} of a burst of ${slots3 + 3}`, q.building === slots3 && q.waiting === 3, q);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
