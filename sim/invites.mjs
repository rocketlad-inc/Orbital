// ============================================================
// INVITES (0175) — who brought whom, through the REAL worker.
//
//   - a signup from an invite link records the inviter (?by=) and code
//   - no or a bad ?by= falls back to the room's host, marked 'host'
//   - a referral is written once; a later stamp cannot rewrite it
//   - an invite CODE skips the room password (it proves the invitation);
//     the browse door still asks for it
//   - every seat says how it was taken: host / code / browse / quick
//   - an opened invite link is counted once per browser, signed in or not
//
// Run: npm run sim:invites
// ============================================================

import worker from '../worker/index.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { stampReferral } from '../worker/invites.js';

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
async function signup(name, attribution) {
  const r = await call('POST', '/api/auth/signup', {
    body: { email: `${name.toLowerCase()}@players.org`, password: 'password123', display_name: name, attribution },
  });
  if (r.status !== 201) throw new Error(`signup ${name} -> ${r.status} ${JSON.stringify(r.data)}`);
  return { name, cookie: r.cookie, id: r.data.user.id };
}
const user = (id) => DB.prepare('SELECT signup_source, signup_invite_code, referred_by, referred_how FROM users WHERE id = ?').bind(id).first();
const seat = (roomId, userId) => DB.prepare('SELECT join_method FROM room_members WHERE room_id = ? AND user_id = ?').bind(roomId, userId).first();

// ---- a host makes a private room --------------------------------------
const host = await signup('Host');
const made = await call('POST', '/api/rooms', { cookie: host.cookie, body: { name: 'Friends only', max_players: 6, password: 'secret1' } });
check('the host can make a password room', made.status === 200 || made.status === 201, made.data);
const room = made.data.room;
const code = room.invite_code;
check('...and its seat says host', (await seat(room.id, host.id))?.join_method === 'host');

// ---- signups that came from an invite ---------------------------------
const friend = await signup('Friend', { invite: true, invite_code: code, by: host.id, first_seen_ms: 1 });
let f = await user(friend.id);
check('a signup from an invite link records the inviter, the code and the source',
  f.referred_by === host.id && f.referred_how === 'link' && f.signup_invite_code === code && f.signup_source === 'invite', f);
const codeOnly = await signup('CodeOnly', { invite: true, invite_code: code.toLowerCase().replace(/(.{4})/, '$1-') });
f = await user(codeOnly.id);
check('a link with no sender falls back to the room host, marked as a guess', f.referred_by === host.id && f.referred_how === 'host', f);
const badBy = await signup('BadBy', { invite: true, invite_code: code, by: 'nobody-at-all-xx' });
f = await user(badBy.id);
check('a sender that is not a real account falls back to the host', f.referred_by === host.id && f.referred_how === 'host', f);
const notInvited = await signup('Organic', { from: 'reddit-post' });
f = await user(notInvited.id);
check('a signup with no invite records no inviter', f.referred_by === null && f.signup_invite_code === null && f.signup_source === 'reddit-post', f);
const junk = await signup('Junk', { invite: true, invite_code: 'not a code' });
check('a malformed code records nothing', (await user(junk.id)).signup_invite_code === null);
await stampReferral(DB, friend.id, { inviteCode: code, by: badBy.id });
check('a referral is written once, never rewritten', (await user(friend.id)).referred_by === host.id);

// ---- the invite code is the one secret -------------------------------
const byCode = await call('POST', '/api/rooms/join-by-code', { cookie: friend.cookie, body: { code } });
check('an invite code joins a password room without the password', byCode.status === 200, byCode.data);
check('...and the seat says code', (await seat(room.id, friend.id))?.join_method === 'code');
const stranger = await signup('Stranger');
const noPw = await call('POST', `/api/rooms/${room.id}/join`, { cookie: stranger.cookie, body: {} });
check('the browse door still asks a stranger for the password', noPw.status === 401 && noPw.data?.error?.code === 'password_required', noPw);
const withPw = await call('POST', `/api/rooms/${room.id}/join`, { cookie: stranger.cookie, body: { password: 'secret1' } });
check('...and lets them in with it', withPw.status === 200, withPw.data);
check('...the seat says browse', (await seat(room.id, stranger.id))?.join_method === 'browse');
const badCode = await call('POST', '/api/rooms/join-by-code', { cookie: notInvited.cookie, body: { code: 'ZZZZZZZZ' } });
check('a code that matches no room joins nothing', badCode.status === 404);

// ---- Quick Join seats -------------------------------------------------
const quick = await call('POST', '/api/rooms/quick-join', { cookie: notInvited.cookie });
check('Quick Join seats a player', (quick.status === 200 || quick.status === 201) && quick.data?.ok, quick.data);
const qRoom = quick.data?.room_id ?? quick.data?.room?.id;
check('...and the seat says quick', qRoom && (await seat(qRoom, notInvited.id))?.join_method === 'quick', { qRoom });

// ---- an opened invite link --------------------------------------------
const open = (body, cookie) => call('POST', '/api/invite/open', { body, cookie });
check('an invite link opened signed out is counted', (await open({ code, anon: 'browserAAAA1', by: host.id })).status === 204);
await open({ code, anon: 'browserAAAA1', by: host.id });
await open({ code, anon: 'browserBBBB2' }, friend.cookie);
await open({ code: 'not-a-code', anon: 'browserCCCC3' });
await open({ code, anon: 'x' });
const opens = (await DB.prepare('SELECT anon_id, by_user, user_id FROM invite_opens WHERE code = ? ORDER BY anon_id').bind(code).all()).results;
check('...once per browser, and a junk code or id is ignored', opens.length === 2, opens);
check('...with the sender, and the account when signed in',
  opens[0].by_user === host.id && opens[1].user_id === friend.id, opens);

// ---- the Recruiter emblem (0176) ---------------------------------------
const me = async (u) => (await call('GET', '/api/auth/me', { cookie: u.cookie })).data?.user;
check('no Recruiter emblem before an invited friend has played', !((await me(host)).emblem_grants ?? []).includes('recruiter'),
  (await me(host)).emblem_grants);
// The friend's game starts: a games row for the room and a seat in it.
DB.db.exec('PRAGMA foreign_keys = OFF');
await DB.prepare(`INSERT INTO games (id, status, map_seed, current_tick, tick_interval_ms, created_at) VALUES (?, 'active', 's', 1, 60000, 0)`).bind(room.id).run();
await DB.prepare(`INSERT INTO game_factions (id, game_id, user_id, name, color, slot, status, joined_at) VALUES (?, ?, ?, 'F', '#4ecdc4', 0, 'active', 0)`)
  .bind(`${room.id}:f0`, room.id, friend.id).run();
DB.db.exec('PRAGMA foreign_keys = ON');
check('the inviter earns the Recruiter emblem once the friend plays', ((await me(host)).emblem_grants ?? []).includes('recruiter'));
check('...granted once', (await DB.prepare(`SELECT COUNT(*) AS n FROM user_emblem_grants WHERE user_id = ?`).bind(host.id).first()).n === 1);
check('someone who invited nobody does not earn it', !((await me(stranger)).emblem_grants ?? []).includes('recruiter'));
const lobby2 = (await call('POST', '/api/rooms', { cookie: host.cookie, body: { name: 'Second', max_players: 4 } })).data.room;
await call('POST', '/api/rooms/join-by-code', { cookie: stranger.cookie, body: { code: lobby2.invite_code } });
const pick = (u, emblem) => call('PATCH', `/api/lobby/rooms/${lobby2.id}/me`, { cookie: u.cookie, body: { emblem } });
const refused = await pick(stranger, 'recruiter');
check('an earned emblem is refused to anyone without the grant', refused.status === 403 && refused.data?.error?.code === 'not_earned', refused);
const flew = await pick(host, 'recruiter');
check('...and flies for the player who earned it', flew.status === 200, flew);

// ---- opening a lonely lobby's seats ------------------------------------
const lonely = (await call('POST', '/api/rooms', { cookie: notInvited.cookie, body: { name: 'Alone', max_players: 4, password: 'secret2' } })).data.room;
const notHost = await call('POST', `/api/lobby/rooms/${lonely.id}/open-seats`, { cookie: stranger.cookie });
check('only the host can open the seats', notHost.status === 403, notHost);
const opened = await call('POST', `/api/lobby/rooms/${lonely.id}/open-seats`, { cookie: notInvited.cookie });
check('the host opens them: the password is gone', opened.status === 200
  && (await DB.prepare('SELECT password_hash FROM rooms WHERE id = ?').bind(lonely.id).first()).password_hash === null, opened.data);
const walkIn = await call('POST', `/api/rooms/${lonely.id}/join`, { cookie: badBy.cookie, body: {} });
check('...so a stranger from Browse walks in with no password', walkIn.status === 200, walkIn.data);
const startedOpen = await call('POST', `/api/lobby/rooms/${room.id}/open-seats`, { cookie: host.cookie });
check('a game that has started cannot be opened this way', startedOpen.status === 409, startedOpen);

console.log(failures === 0 ? '\nALL INVITE CHECKS PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
