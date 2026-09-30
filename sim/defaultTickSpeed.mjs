// ============================================================
// The default play speed is one hour a tick -- drives the REAL worker.
//
// Lorne, 2026-09-30: "Make the default play speed 1 hour. I think it's at
// 7.5 minutes." A game whose host never touches the speed picker must
// start at 3_600_000 ms, the lobby must say so before it starts, and a
// host who DID pick a speed must still get it.
//
// Run: npm run sim:tickspeed
// ============================================================

import worker from '../worker/index.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures++; if (detail !== undefined) console.log(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); }
}

// A Room DO that remembers what the lobby told it, per room -- the speed
// a host picks lives there until the game starts.
const doSettings = new Map();
const ROOM = {
  idFromName: (name) => name,
  get: (id) => ({
    async fetch(url, init) {
      const path = new URL(typeof url === 'string' ? url : url.url).pathname;
      if (path === '/settings') {
        const cur = doSettings.get(id) ?? {};
        if ((init?.method ?? 'GET') === 'POST') {
          const body = JSON.parse(init.body ?? '{}');
          if (Number.isInteger(body.tick_interval_ms)) cur.tick_interval_ms = body.tick_interval_ms;
          doSettings.set(id, cur);
        }
        return Response.json(cur);
      }
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
async function lobby(host, guest, name) {
  const c = await call('POST', '/api/rooms', { cookie: host.cookie, body: { name, max_players: 2 } });
  await call('POST', `/api/rooms/${c.data.room.id}/join`, { cookie: guest.cookie });
  return c.data.room.id;
}
const startedAt = async (id) => (await DB.prepare('SELECT tick_interval_ms FROM games WHERE id = ?').bind(id).first())?.tick_interval_ms;

const A = await signup('Ada');
const B = await signup('Bex');

// ---- nobody touches the speed ------------------------------------------------
const plain = await lobby(A, B, 'Left alone');
const pre = await call('GET', `/api/lobby/rooms/${plain}/settings`, { cookie: A.cookie });
check('the lobby shows one hour before the game starts', pre.data?.settings?.tick_interval_ms === 3_600_000, pre.data);
const s1 = await call('POST', `/api/lobby/rooms/${plain}/start`, { cookie: A.cookie });
check('the game starts', s1.status === 200, s1);
check('and runs at one hour a tick', (await startedAt(plain)) === 3_600_000, await startedAt(plain));

// ---- a host who picks a speed still gets it -------------------------------------
const picked = await lobby(A, B, 'Host picked');
const set = await call('PATCH', `/api/lobby/rooms/${picked}/settings`, { cookie: A.cookie, body: { tick_interval_ms: 450_000 } });
check('a host can still choose 7.5 minutes', set.status === 200, set);
await call('POST', `/api/lobby/rooms/${picked}/start`, { cookie: A.cookie });
check('and the game starts at the speed they chose', (await startedAt(picked)) === 450_000, await startedAt(picked));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
