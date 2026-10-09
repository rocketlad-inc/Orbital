// ============================================================
// Restyle the fleet -- drives the REAL /designs + /restyle routes.
//
// Shipwright (2026-10-08): "Give the fleet this look". Every live hull of
// the design's class takes the design's look, now and free, and nothing
// else changes. Refit-fleet never copied the look on its immediate path,
// so a bought-and-chosen look left the fleet flying the old one.
//
// Run: npm run sim:restyle
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

const A = await signup('Owner');
const B = await signup('Rival');
const c = await call('POST', '/api/rooms', { cookie: A.cookie, body: { name: 'Restyle', max_players: 2 } });
const G = c.data.room.id;
await call('POST', `/api/rooms/${G}/join`, { cookie: B.cookie });
const s = await call('POST', `/api/lobby/rooms/${G}/start`, { cookie: A.cookie });
if (s.status !== 200) throw new Error(`start ${s.status} ${JSON.stringify(s.data)}`);
await DB.prepare(`UPDATE games SET status = 'active', gating_enabled = 0, current_tick = 40 WHERE id = ?`).bind(G).run();
const fac = async (u) => DB.prepare('SELECT id, capital_body_id FROM game_factions WHERE game_id = ? AND user_id = ?').bind(G, u.id).first();
const fa = await fac(A), fb = await fac(B);

// Three destroyers and a frigate of A's, a destroyer of B's, all flying B.
const seed = (await DB.prepare(`SELECT id FROM game_ships WHERE game_id = ? LIMIT 1`).bind(G).first()).id;
const put = (id, owner, cls) => cloneRow('game_ships', seed, {
  id: `${G}:${id}`, name: id, owner_faction_id: owner, ship_class: cls, status: 'active',
  icon_variant: 'B', captain_id: null, fleet_id: null,
});
for (const id of ['d1', 'd2', 'd3']) await put(id, fa.id, 'destroyer');
await put('f1', fa.id, 'frigate');
await put('rd', fb.id, 'destroyer');
const look = async (id) => (await DB.prepare('SELECT icon_variant v FROM game_ships WHERE id = ?').bind(`${G}:${id}`).first())?.v;

// A design with a free look (C, Trident).
const mk = await call('POST', `/api/games/${G}/designs`, { cookie: A.cookie, body: { ship_class: 'destroyer', name: 'Trident Mk I', parts: [], icon_variant: 'C' } });
check('a design with a free look saves', mk.status === 200 || mk.status === 201, [mk.status, mk.data]);
const designId = mk.data?.design?.id;

let r = await call('POST', `/api/games/${G}/designs/${designId}/restyle`, { cookie: A.cookie });
check('restyle answers ok and counts the hulls it changed', r.status === 200 && r.data?.restyled === 3, [r.status, r.data]);
check('every live destroyer of yours takes the look',
  (await look('d1')) === 'C' && (await look('d2')) === 'C' && (await look('d3')) === 'C');
check('another class is untouched', (await look('f1')) === 'B');
check("a rival's destroyer is untouched", (await look('rd')) === 'B');
r = await call('POST', `/api/games/${G}/designs/${designId}/restyle`, { cookie: A.cookie });
check('a second restyle changes nothing', r.status === 200 && r.data?.restyled === 0, r.data);

r = await call('POST', `/api/games/${G}/designs/${designId}/restyle`, { cookie: B.cookie });
check("you cannot restyle with someone else's design", r.status === 403, [r.status, r.data]);

// A Commission look needs the Commission, here as on every save.
await DB.prepare(`UPDATE game_ship_designs SET icon_variant = 'Q' WHERE id = ?`).bind(designId).run();
r = await call('POST', `/api/games/${G}/designs/${designId}/restyle`, { cookie: A.cookie });
check('a Commission look without the Commission is refused', r.status === 403 && r.data?.error?.code === 'premium_required', [r.status, r.data]);
check('...and nothing changed', (await look('d1')) === 'C');
await DB.prepare(`INSERT INTO user_entitlements (user_id, sku, source, granted_at) VALUES (?, 'cosmetics_v1', 'admin', 0)`).bind(A.id).run();
r = await call('POST', `/api/games/${G}/designs/${designId}/restyle`, { cookie: A.cookie });
check('with the Commission the fleet flies it', r.status === 200 && (await look('d1')) === 'Q' && (await look('d3')) === 'Q', [r.status, r.data]);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
