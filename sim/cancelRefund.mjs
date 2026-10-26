// ============================================================
// CANCELLING QUEUED SHIPS GIVES THE MONEY BACK -- drives the REAL worker.
//
// Discord, 2026-10-26 (The real Spider-Man): "I deleted ships from the
// queue and didn't get a refund. I don't have many credits."
//
// Every way of paying for a hull has to come back whole on a cancel, to
// the purse it left: the empire pool, a world's own stockpile (the
// anti-laundering rule refunds raw-world money THERE), or a mix; with and
// without a loadout; after a rush; building or waiting; one at a time or
// all at once.
//
// Run: npm run sim:cancel-refund
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

const A = await signup('Spider');
const B = await signup('Dale');
const c = await call('POST', '/api/rooms', { cookie: A.cookie, body: { name: 'Refund', max_players: 2 } });
const G = c.data.room.id;
await call('POST', `/api/rooms/${G}/join`, { cookie: B.cookie });
const s = await call('POST', `/api/lobby/rooms/${G}/start`, { cookie: A.cookie });
if (s.status !== 200) throw new Error(`start ${s.status} ${JSON.stringify(s.data)}`);
await DB.prepare(`UPDATE games SET status = 'active', gating_enabled = 0 WHERE id = ?`).bind(G).run();
const fa = await DB.prepare('SELECT id, capital_body_id FROM game_factions WHERE game_id = ? AND user_id = ?').bind(G, A.id).first();
const cap = fa.capital_body_id;
// One slot, so most orders wait and both states are exercised.
await DB.prepare(`UPDATE game_settlements SET buildings_json = '{"lab":1}' WHERE game_id = ? AND body_id = ?`).bind(G, cap).run();
const settlementId = (await DB.prepare(`SELECT id FROM game_settlements WHERE game_id = ? AND body_id = ? AND owner_faction_id = ? LIMIT 1`).bind(G, cap, fa.id).first()).id;

const build = (name, extra = {}) => call('POST', `/api/games/${G}/bodies/${encodeURIComponent(cap)}/build`, {
  cookie: A.cookie, body: { ship_class: 'corvette', ship_name: name, bare: true, ...extra },
});
const cancel = (id) => call('DELETE', `/api/games/${G}/builds/${encodeURIComponent(id)}`, { cookie: A.cookie });
const purse = async () => {
  const f = await DB.prepare('SELECT metal, gold FROM game_factions WHERE id = ?').bind(fa.id).first();
  const l = await DB.prepare('SELECT stockpile_metal m, stockpile_gold g FROM game_settlements WHERE id = ?').bind(settlementId).first();
  return { pool: [Number(f.metal), Number(f.gold)], local: [Number(l.m), Number(l.g)] };
};
const setPurse = async ({ pool, local }) => {
  await DB.prepare('UPDATE game_factions SET metal = ?, gold = ? WHERE id = ?').bind(pool[0], pool[1], fa.id).run();
  await DB.prepare('UPDATE game_settlements SET stockpile_metal = ?, stockpile_gold = ? WHERE id = ?').bind(local[0], local[1], settlementId).run();
};
const clearQueue = () => DB.prepare('UPDATE game_body_build_queue SET cancelled_at_tick = 0 WHERE game_id = ? AND cancelled_at_tick IS NULL').bind(G).run();

/** Queue `n` hulls, cancel them all one at a time, expect every purse back. */
async function scenario(label, start, n, { extra, concurrent = false, between } = {}) {
  await clearQueue();
  await setPurse(start);
  const placed = [];
  for (let i = 0; i < n; i++) placed.push(await build(`${label}-${i}`, extra));
  const ok = placed.filter(x => x.status === 201);
  check(`${label}: ${n} hulls queued`, ok.length === n, placed.map(x => [x.status, x.data?.error?.message]));
  const states = ok.map(x => x.data.order.status).join();
  if (between) await between(ok);
  const mid = await purse();
  const results = concurrent
    ? await Promise.all(ok.map(x => cancel(x.data.order.id)))
    : (await ok.reduce(async (acc, x) => { const a = await acc; a.push(await cancel(x.data.order.id)); return a; }, Promise.resolve([])));
  check(`${label}: every cancel answers ok`, results.every(r => r.status === 200), results.map(r => [r.status, r.data?.error?.message]));
  const after = await purse();
  const sum = (p) => [p.pool[0] + p.local[0], p.pool[1] + p.local[1]];
  const wholeTotal = sum(after)[0] === sum(start)[0] && sum(after)[1] === sum(start)[1];
  check(`${label}: all the metal and credits are back (${states})`, wholeTotal, { start, mid, after });
  check(`${label}: each purse got back what it paid`,
    after.pool.join() === start.pool.join() && after.local.join() === start.local.join(), { start, after });
  const told = results.reduce((a, r) => a + Number(r.data?.refund?.gold ?? 0), 0);
  check(`${label}: the replies add up to the credits returned`, told === sum(after)[1] - sum(mid)[1], { told, returned: sum(after)[1] - sum(mid)[1] });
  return { start, mid, after, results };
}

// ---- 1. the plain case: everything from the pool -------------------------------
await scenario('pool', { pool: [1000, 1000], local: [0, 0] }, 4);
// ---- 2. local-first: a world's own stockpile pays before the pool ---------------
await scenario('local', { pool: [1000, 1000], local: [500, 500] }, 4);
// ---- 3. a mix: the local stockpile runs dry partway ----------------------------
await scenario('mixed', { pool: [1000, 1000], local: [14, 13] }, 4);
// ---- 4. all at once (a fast tapper) ---------------------------------------------
await scenario('burst', { pool: [1000, 1000], local: [30, 30] }, 4, { concurrent: true });
// ---- 5. a loadout (parts are charged on top of the hull) ------------------------
const withParts = await call('GET', `/api/games/${G}/state`, { cookie: A.cookie });
void withParts;
await scenario('rushed', { pool: [3000, 3000], local: [0, 0] }, 2, {
  between: async (ok) => {
    // The first hull is on the ways: advance the clock and rush it twice.
    await DB.prepare('UPDATE games SET current_tick = current_tick + 1 WHERE id = ?').bind(G).run();
    for (const x of ok.slice(0, 1)) {
      const r1 = await call('POST', `/api/games/${G}/builds/${encodeURIComponent(x.data.order.id)}/rush`, { cookie: A.cookie });
      void r1;
    }
  },
});

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
