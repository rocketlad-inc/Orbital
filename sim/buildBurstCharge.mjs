// ============================================================
// Three quick BUILD clicks with plenty banked -- drives the REAL worker.
//
// Playtest, 2026-10-24 (Priya): clicking BUILD three times fast queued ONE
// ship and answered the other two with "Couldn't pay for this ship - 9
// metal + 8 credits" while the treasury held hundreds.
//
// The cause: each order planned its draw from the world's LOCAL stockpile
// against a snapshot, so the second and third planned to take the same
// local metal the first had just spent. Their guarded debit missed (right
// to refuse an overdraft) and the whole order was refused, although the
// empire pool could pay for it easily. An order now re-plans against
// fresh balances when its debit misses, and only says "couldn't pay" when
// the money really is not there.
//
// Also checks the queue is first come, first served: an order placed while
// older ones are waiting never takes a slot ahead of them (Priya again:
// "ordered Stiletto, Rapier, Raptor, Talon; Raptor built first").
//
// Run: npm run sim:buildburst
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

const A = await signup('Priya');
const B = await signup('Dale');
const c = await call('POST', '/api/rooms', { cookie: A.cookie, body: { name: 'Burst', max_players: 2 } });
const G = c.data.room.id;
await call('POST', `/api/rooms/${G}/join`, { cookie: B.cookie });
const s = await call('POST', `/api/lobby/rooms/${G}/start`, { cookie: A.cookie });
if (s.status !== 200) throw new Error(`start ${s.status} ${JSON.stringify(s.data)}`);
await DB.prepare(`UPDATE games SET status = 'active', gating_enabled = 0 WHERE id = ?`).bind(G).run();
const fa = await DB.prepare('SELECT id, capital_body_id FROM game_factions WHERE game_id = ? AND user_id = ?').bind(G, A.id).first();
const cap = fa.capital_body_id;
// One slot, so the queue order is visible.
await DB.prepare(`UPDATE game_settlements SET buildings_json = '{"lab":1}' WHERE game_id = ? AND body_id = ?`).bind(G, cap).run();

const build = (name) => call('POST', `/api/games/${G}/bodies/${encodeURIComponent(cap)}/build`, {
  cookie: A.cookie, body: { ship_class: 'corvette', ship_name: name, bare: true },
});
const purse = async () => {
  const f = await DB.prepare('SELECT metal, gold FROM game_factions WHERE id = ?').bind(fa.id).first();
  const l = await DB.prepare(`SELECT COALESCE(SUM(stockpile_metal),0) m, COALESCE(SUM(stockpile_gold),0) g FROM game_settlements
                                WHERE game_id = ? AND body_id = ? AND owner_faction_id = ? AND destroyed_at_tick IS NULL`).bind(G, cap, fa.id).first();
  return { pool: [Number(f.metal), Number(f.gold)], local: [Number(l.m), Number(l.g)] };
};

// ---- the reported case: a little banked locally, plenty in the pool ----------
await DB.prepare('UPDATE game_factions SET metal = 500, gold = 500 WHERE id = ?').bind(fa.id).run();
// Enough local metal and credits to pay for ONE corvette and part of a second.
await DB.prepare(`UPDATE game_settlements SET stockpile_metal = 0, stockpile_gold = 0 WHERE game_id = ? AND body_id = ?`).bind(G, cap).run();
await DB.prepare(`UPDATE game_settlements SET stockpile_metal = 14, stockpile_gold = 13
                   WHERE id = (SELECT id FROM game_settlements WHERE game_id = ? AND body_id = ? AND owner_faction_id = ? LIMIT 1)`).bind(G, cap, fa.id).run();
const before = await purse();
const r = await Promise.all([build('Stiletto'), build('Rapier'), build('Raptor')]);
check('three quick orders with plenty banked are all accepted', r.every(x => x.status === 201),
  r.map(x => [x.status, x.data?.error?.message]));
const after = await purse();
const spent = (before.pool[0] + before.local[0]) - (after.pool[0] + after.local[0]);
const charged = (await DB.prepare(`SELECT charge_json FROM game_body_build_queue WHERE game_id = ? AND cancelled_at_tick IS NULL`).bind(G).all()).results
  .map(x => JSON.parse(x.charge_json)).reduce((a, j) => a + j.pool.metal + j.local.reduce((b, l) => b + l.metal, 0), 0);
check('what left the purses is exactly what the orders recorded', spent === charged, { spent, charged });
check('no purse went negative', after.pool.every(v => v >= 0) && after.local.every(v => v >= 0), after);

// ---- a genuinely short purse is still refused, and nothing is taken ----------
await DB.prepare('UPDATE game_body_build_queue SET cancelled_at_tick = 0 WHERE game_id = ?').bind(G).run();
await DB.prepare(`UPDATE game_settlements SET stockpile_metal = 0, stockpile_gold = 0 WHERE game_id = ? AND body_id = ?`).bind(G, cap).run();
await DB.prepare('UPDATE game_factions SET metal = 15, gold = 15 WHERE id = ?').bind(fa.id).run();
const short = await Promise.all([build('A1'), build('A2'), build('A3')]);
check('with money for one, exactly one is accepted', short.filter(x => x.status === 201).length === 1, short.map(x => x.status));
const p2 = await purse();
check('the refused ones took nothing', p2.pool[0] >= 0 && p2.pool[0] === 15 - 10 && p2.pool[1] === 15 - 10, p2);

// ---- first come, first served ------------------------------------------------
await DB.prepare('UPDATE game_body_build_queue SET cancelled_at_tick = 0 WHERE game_id = ?').bind(G).run();
await DB.prepare('UPDATE game_factions SET metal = 1000, gold = 1000 WHERE id = ?').bind(fa.id).run();
const names = ['Stiletto', 'Rapier', 'Raptor', 'Talon'];
const placed = [];
for (const n of names) placed.push(await build(n));
check('the first order builds and the rest wait', placed.map(x => x.data?.order?.status).join() === 'building,waiting,waiting,waiting',
  placed.map(x => x.data?.order?.status));
// Cancel the hull on the ways: its slot is free until the next tick promotes.
const firstId = placed[0].data.order.id;
const cx = await call('DELETE', `/api/games/${G}/builds/${encodeURIComponent(firstId)}`, { cookie: A.cookie });
check('the building hull can be cancelled', cx.status === 200, [cx.status, cx.data]);
const late = await build('Latecomer');
check('a new order does not jump the three already waiting', late.data?.order?.status === 'waiting', late.data?.order?.status);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
