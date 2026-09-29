// ============================================================
// Leaving a lobby -- drives the REAL worker fetch handler over SimD1 with
// a fake Room DO, like sim/emailQuickJoin.mjs.
//
// Lorne, 2026-09-28: "add a button to the pregame lobby to leave the
// lobby". Back only navigated away; the seat stayed taken. Pins down:
//   * a member who leaves frees the seat, drops off My Games, and the
//     room's live roster is told (DO /kick for them);
//   * a host who leaves hands the room to whoever has waited longest;
//   * a host alone is refused (last_member) -- the lobby is deleted, not
//     left hostless;
//   * no leaving once the game exists, and no leaving a room you are not in.
//
// Run: npm run sim:leave
// ============================================================

import worker from '../worker/index.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures++; if (detail !== undefined) console.log(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); }
}

const doCalls = [];
const ROOM = {
  idFromName: (name) => name,
  get: (id) => ({
    async fetch(url, init) {
      const path = new URL(typeof url === 'string' ? url : url.url).pathname;
      let body = null;
      try { body = init?.body ? JSON.parse(init.body) : null; } catch { body = null; }
      doCalls.push({ id, path, body });
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

const leave = (u, roomId) => call('POST', `/api/lobby/rooms/${roomId}/leave`, { cookie: u.cookie });
const memberIds = async (roomId) => (await DB.prepare('SELECT user_id FROM room_members WHERE room_id = ? ORDER BY joined_at').bind(roomId).all()).results.map(r => r.user_id);
const hostOf = async (roomId) => (await DB.prepare('SELECT host_id FROM rooms WHERE id = ?').bind(roomId).first())?.host_id;

// Joins spaced out so "waited longest" is well defined.
async function lobby(host, others) {
  const c = await call('POST', '/api/rooms', { cookie: host.cookie, body: { name: `${host.name} room`, max_players: 5 } });
  const id = c.data.room.id;
  let t = Date.now();
  for (const u of others) {
    await call('POST', `/api/rooms/${id}/join`, { cookie: u.cookie });
    await DB.prepare('UPDATE room_members SET joined_at = ? WHERE room_id = ? AND user_id = ?').bind(t += 1000, id, u.id).run();
  }
  return id;
}

// ---- a member leaves -------------------------------------------------------

const A = await signup('Ada');
const B = await signup('Bea');
const C = await signup('Cal');
const room = await lobby(A, [B, C]);

doCalls.length = 0;
const r1 = await leave(C, room);
check('a member can leave a lobby', r1.status === 200 && r1.data.ok === true, r1);
check('their seat is freed', !(await memberIds(room)).includes(C.id), await memberIds(room));
check('the host is unchanged', (await hostOf(room)) === A.id);
check('the room\'s live roster is told to drop them',
  doCalls.some(d => d.id === room && d.path === '/kick' && d.body?.userId === C.id), doCalls);
const mine = await call('GET', '/api/lobby/mine', { cookie: C.cookie });
check('the lobby is gone from their My Games', !(mine.data.games ?? []).some(g => g.id === room), mine.data);
const snap = await call('GET', `/api/lobby/rooms/${room}`, { cookie: C.cookie });
check('and they no longer read the room as a member', snap.status === 403 || snap.status === 404, snap.status);

const again = await leave(C, room);
check('leaving twice is a clean 404, not a crash', again.status === 404 && again.data?.error?.code === 'not_member', again);

// Rejoin still works: leaving is not a ban.
const back = await call('POST', `/api/rooms/${room}/join`, { cookie: C.cookie });
check('a player who left can join again', back.status === 200 && (await memberIds(room)).includes(C.id), back);

// ---- the host leaves -------------------------------------------------------

const D = await signup('Dee');
const E = await signup('Eli');
const F = await signup('Fox');
const room2 = await lobby(D, [E, F]);
const r2 = await leave(D, room2);
check('a host can leave', r2.status === 200, r2);
check('the host hands the room to whoever waited longest', (await hostOf(room2)) === E.id && r2.data.new_host_id === E.id,
  { host: await hostOf(room2), E: E.id, F: F.id });
check('and the old host\'s seat is gone', !(await memberIds(room2)).includes(D.id));
const settingsAsE = await call('PATCH', `/api/lobby/rooms/${room2}/settings`, { cookie: E.cookie, body: { name: 'Eli runs it now' } });
check('the new host has the host controls', settingsAsE.status === 200, settingsAsE);

// ---- a host alone ----------------------------------------------------------

const G = await signup('Gil');
const room3 = await lobby(G, []);
const r3 = await leave(G, room3);
check('a host alone is refused: delete the lobby instead', r3.status === 409 && r3.data?.error?.code === 'last_member', r3);
check('and stays seated as host', (await memberIds(room3)).includes(G.id) && (await hostOf(room3)) === G.id);

// ---- not after the start, not someone else's room ---------------------------

const H = await signup('Hal');
const I = await signup('Ivy');
const room4 = await lobby(H, [I]);
await DB.prepare("INSERT INTO games (id, status, map_seed, created_at) VALUES (?, 'active', 'x', ?)").bind(room4, Date.now()).run();
const r4 = await leave(I, room4);
check('no leaving once the game has started', r4.status === 409 && r4.data?.error?.code === 'already_started', r4);
check('and the seat is kept', (await memberIds(room4)).includes(I.id));

const r5 = await leave(A, room2);
check('you cannot leave a room you are not in', r5.status === 404, r5);
const r6 = await call('POST', `/api/lobby/rooms/${room}/leave`);
check('signed out: refused', r6.status === 401, r6.status);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
