// ============================================================
// The Kuiper Belt / Far Reach metal-credit swap -- the catalogue for new
// games, and worker/outerYieldSwap.js for games already running.
//
// Lorne, 2026-09-29: "for all the worlds in the Far Reach and Kuiper Belt
// that are not yet claimed, swap their credit and metal values."
//
// Seeds a REAL game through the worker, checks the new catalogue landed,
// then winds that game back to the old numbers (a game seeded before the
// change) with one world settled, one merely owned, one impact-halved and
// one hand-edited, and runs the live plan and its SQL over it.
//
// Run: npm run sim:outerswap
// ============================================================

import worker from '../worker/index.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { planOuterYieldSwap, outerYieldSwapSql } from '../worker/outerYieldSwap.js';

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures++; if (detail !== undefined) console.log(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); }
}

const ROOM = {
  idFromName: (name) => name,
  get: () => ({
    async fetch(url) {
      const path = new URL(typeof url === 'string' ? url : url.url).pathname;
      if (path === '/settings') return Response.json({});
      return Response.json({ ok: true });
    },
  }),
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
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, data, cookie: setCookie ? setCookie.split(';')[0] : null };
}
async function signup(name) {
  const r = await call('POST', '/api/auth/signup', {
    body: { email: `${name.toLowerCase()}@example.com`, password: 'password123', display_name: name },
  });
  if (r.status !== 201) throw new Error(`signup ${name} -> ${r.status} ${JSON.stringify(r.data)}`);
  return { name, cookie: r.cookie, id: r.data.user.id };
}

const A = await signup('Ada');
const B = await signup('Bex');
const created = await call('POST', '/api/rooms', { cookie: A.cookie, body: { name: 'Outer yields', max_players: 2 } });
const gid = created.data.room.id;
await call('POST', `/api/rooms/${gid}/join`, { cookie: B.cookie });
const started = await call('POST', `/api/lobby/rooms/${gid}/start`, { cookie: A.cookie });
if (started.status !== 200) throw new Error(`start -> ${started.status} ${JSON.stringify(started.data)}`);

const bodies = async () => (await DB.prepare('SELECT * FROM game_bodies WHERE game_id = ?').bind(gid).all()).results;
const byT = async () => new Map((await bodies()).map(b => [b.template_id, b]));
const settled = async () => new Set((await DB.prepare(
  'SELECT DISTINCT body_id FROM game_settlements WHERE game_id = ? AND destroyed_at_tick IS NULL',
).bind(gid).all()).results.map(r => r.body_id));
const MG = (b) => `M${b.yield_metal} C${b.yield_gold}`;
const names = (xs) => xs.map(r => r.template).sort().join(',');

// ---- a NEW game gets the new catalogue --------------------------------------
let t = await byT();
check('Eris is metal now, not credits (M5 C0)', MG(t.get('eris')) === 'M5 C0', MG(t.get('eris')));
check('Vagrant, a Kuiper rogue, too (M7 C2)', MG(t.get('vagrant')) === 'M7 C2', MG(t.get('vagrant')));
check('Varda keeps its science', t.get('varda').yield_science === 6 && MG(t.get('varda')) === 'M3 C1', MG(t.get('varda')));
check('the Plutinos are untouched (Pluto M2 C4)', MG(t.get('pluto')) === 'M2 C4', MG(t.get('pluto')));
check('the inner system is untouched (Ceres M6 C3)', MG(t.get('ceres')) === 'M6 C3', MG(t.get('ceres')));
const fresh = planOuterYieldSwap(await bodies(), await settled());
check('a game seeded after the change has nothing to swap', fresh.swap.length === 0 && fresh.already.length === 17,
  { swap: fresh.swap.length, already: names(fresh.already), odd: names(fresh.odd) });

// ---- wind it back to a game seeded BEFORE the change ---------------------------
const unwind = fresh.already.map(r => `'${r.template}'`).join(',');
await DB.prepare(`UPDATE game_bodies SET yield_metal = yield_gold, yield_gold = yield_metal
                   WHERE game_id = ? AND template_id IN (${unwind})`).bind(gid).run();
t = await byT();
// Sedna is settled: copy a real settlement row onto it.
const cols = (await DB.prepare('PRAGMA table_info(game_settlements)').all()).results.map(c => c.name);
const settle = async (id, bodyId) => {
  const pick = cols.map(c => (c === 'id' ? `'${id}'` : c === 'body_id' ? '?' : c)).join(', ');
  await DB.prepare(`INSERT INTO game_settlements (${cols.join(', ')}) SELECT ${pick} FROM game_settlements WHERE game_id = ? LIMIT 1`)
    .bind(bodyId, gid).run();
};
await settle('st_sedna', t.get('sedna').id);
// Quaoar is owned outright.
const fid = (await DB.prepare('SELECT id FROM game_factions WHERE game_id = ? LIMIT 1').bind(gid).first()).id;
await DB.prepare('UPDATE game_bodies SET owner_faction_id = ? WHERE id = ?').bind(fid, t.get('quaoar').id).run();
// Vagrant took an impact: half of its old M2 C7.
await DB.prepare('UPDATE game_bodies SET yield_metal = 1, yield_gold = 3 WHERE id = ?').bind(t.get('vagrant').id).run();
// And one row somebody hand-edited, matching neither catalogue.
await DB.prepare('UPDATE game_bodies SET yield_metal = 9, yield_gold = 1 WHERE id = ?').bind(t.get('namaka').id).run();

const plan = planOuterYieldSwap(await bodies(), await settled());
check('settled and owned worlds are left alone', names(plan.claimed) === 'quaoar,sedna', names(plan.claimed));
check('worlds with equal metal and credits need nothing', names(plan.even) === 'hiiaka,ilmare,varuna', names(plan.even));
check('a hand-edited world is reported, not guessed at', names(plan.odd) === 'namaka', names(plan.odd));
check('the rest are swapped, the impact-halved rogue included',
  plan.swap.length === 14 && plan.swap.some(r => r.template === 'vagrant'), names(plan.swap));
check('no Plutino or inner world is in the plan',
  ![...plan.swap, ...plan.claimed, ...plan.even, ...plan.odd]
    .some(r => ['pluto', 'charon', 'orcus', 'vanth', 'ixion', 'ceres', 'titan'].includes(r.template)));

// ---- the write ---------------------------------------------------------------
// A colony lands on Haumea between the plan and the write.
await settle('st_haumea', t.get('haumea').id);
const res = await DB.prepare(outerYieldSwapSql(gid, plan)).run();
t = await byT();
check('the write swaps the planned worlds (13: not Haumea)', res.meta.changes === 13, res.meta);
check('Eris is M5 C0 again', MG(t.get('eris')) === 'M5 C0', MG(t.get('eris')));
check('the halved rogue is swapped as it stands (M3 C1)', MG(t.get('vagrant')) === 'M3 C1', MG(t.get('vagrant')));
check('Haumea, settled after the plan, keeps its old numbers (M2 C3)', MG(t.get('haumea')) === 'M2 C3', MG(t.get('haumea')));
check('Sedna, settled, keeps its old numbers (M1 C4)', MG(t.get('sedna')) === 'M1 C4', MG(t.get('sedna')));
check('Quaoar, owned, keeps its old numbers (M2 C3)', MG(t.get('quaoar')) === 'M2 C3', MG(t.get('quaoar')));
check('the hand-edited world is untouched (M9 C1)', MG(t.get('namaka')) === 'M9 C1', MG(t.get('namaka')));
check('science is untouched', t.get('varda').yield_science === 6 && t.get('mani').yield_science === 5);

const again = planOuterYieldSwap(await bodies(), await settled());
check('running it again swaps nothing', again.swap.length === 0 && outerYieldSwapSql(gid, again) === null, names(again.swap));
const replay = await DB.prepare(outerYieldSwapSql(gid, plan)).run();
check('even replaying the first write changes nothing', replay.meta.changes === 0, replay.meta);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
