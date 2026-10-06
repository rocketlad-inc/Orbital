// ============================================================
// Quick Join + email — drives the REAL worker fetch handler (signup,
// quick-join, join, forgot/reset, unsubscribe) over SimD1, with a fake
// EMAIL binding that records every message instead of sending it, and a
// fake Room DO that answers the handful of calls the lobby makes.
//
// What it pins down:
//   * Quick Join picks the room with the FEWEST seats left, skips
//     password rooms, stale rooms and rooms you are already in, returns
//     you to your own waiting Quick Join room instead of opening another,
//     and opens a 5-seat room with you hosting when nothing fits.
//   * A Quick Join room starts itself on its last seat — once.
//   * Every email is sent at most once (dedupe), carries a text part,
//     and the non-account ones carry a working one-click unsubscribe.
//   * Password reset: unknown addresses get the same answer; a token
//     works once, expires, signs every other session out; rate limit.
//
// Run: npm run sim:email
// ============================================================

import worker from '../worker/index.js';
import * as mail from '../worker/email.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures++; if (detail !== undefined) console.log(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); }
}

// ---- fakes -----------------------------------------------------------------

const sent = [];
const EMAIL = { async send(msg) { sent.push(msg); return { messageId: `m${sent.length}` }; } };

const doCalls = [];
const ROOM = {
  idFromName: (name) => name,
  get: (id) => ({
    async fetch(url, init) {
      const path = new URL(typeof url === 'string' ? url : url.url).pathname;
      doCalls.push({ id, path });
      if (path === '/settings') return Response.json({});
      return Response.json({ ok: true });
    },
  }),
};

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
// Record them, so the worker's own ensureMigrated sees an up-to-date
// database and leaves it alone.
DB.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
for (const m of MIGRATIONS) DB.db.prepare('INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, 0)').run(m.name);
const env = { DB, ROOM, EMAIL, EMAIL_LINK_SECRET: 'sim-secret' };
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

let n = 0;
async function signup(name) {
  n++;
  const r = await call('POST', '/api/auth/signup', {
    body: { email: `${name.toLowerCase()}@example.com`, password: 'password123', display_name: name },
  });
  if (r.status !== 201) throw new Error(`signup ${name} -> ${r.status} ${JSON.stringify(r.data)}`);
  return { name, cookie: r.cookie, id: r.data.user.id, email: r.data.user.email };
}

const quickJoin = (u) => call('POST', '/api/rooms/quick-join', { cookie: u.cookie });
const members = async (roomId) => (await DB.prepare('SELECT COUNT(*) AS c FROM room_members WHERE room_id = ?').bind(roomId).first()).c;
const mailTo = (addr, kind) => sent.filter(m => m.to === addr && (!kind || m.__kind === kind));

// Tag each recorded message with its kind from the subject, for readability.
const kindOf = (m) => /is full: start the game/.test(m.subject) ? 'lobby_full'
  : /^Welcome/.test(m.subject) ? 'welcome'
  : /Reset your/.test(m.subject) ? 'reset'
  : /has begun/.test(m.subject) ? 'game_started'
  : /Herald/.test(m.subject) ? 'herald'
  : /won|wins/.test(m.subject) ? 'game_over' : 'other';

// ---- welcome ---------------------------------------------------------------

const A = await signup('Ada');
sent.forEach(m => { m.__kind = kindOf(m); });
check('signup sends exactly one welcome email', mailTo(A.email, 'welcome').length === 1, sent.map(m => m.subject));
const w = mailTo(A.email, 'welcome')[0];
check('welcome has an HTML and a text part', !!w?.html && !!w?.text && /quick join/i.test(w.text));
check('welcome comes from noreply@ with replies to support@',
  w?.from?.email === 'noreply@orbital-empire.com' && w?.replyTo === 'support@orbital-empire.com');
await mail.sendWelcome(env, { id: A.id, email: A.email, display_name: 'Ada' });
check('a second welcome for the same account is dropped by dedupe', sent.length === 1);

// ---- quick join: create, return, fill ---------------------------------------

const r1 = await quickJoin(A);
check('quick join with no open rooms creates one', r1.status === 201 && r1.data.created === true, r1);
const roomA = r1.data.room_id;
const rowA = await DB.prepare('SELECT max_players, quick_join, host_id, password_hash FROM rooms WHERE id = ?').bind(roomA).first();
check('the new room seats 5 (host + 4 open), is marked quick_join, hosted by the caller',
  rowA.max_players === 5 && rowA.quick_join === 1 && rowA.host_id === A.id && rowA.password_hash == null, rowA);
const r1b = await quickJoin(A);
check('pressing it again returns the same waiting room instead of opening another',
  r1b.data.room_id === roomA && r1b.data.created === false, r1b.data);

// A host-made room with ONE seat left, a password room and a stale room.
const E = await signup('Eve');
const F = await signup('Fay');
const cE = await call('POST', '/api/rooms', { cookie: E.cookie, body: { name: 'Eve room', max_players: 3 } });
const roomE = cE.data.room.id;
await call('POST', `/api/rooms/${roomE}/join`, { cookie: F.cookie });
const P = await signup('Pat');
const cP = await call('POST', '/api/rooms', { cookie: P.cookie, body: { name: 'Locked', max_players: 3, password: 'hunter22' } });
await call('POST', `/api/rooms/${cP.data.room.id}/join`, { cookie: (await signup('Pia')).cookie, body: { password: 'hunter22' } });
const S = await signup('Sam');
const cS = await call('POST', '/api/rooms', { cookie: S.cookie, body: { name: 'Stale', max_players: 3 } });
await call('POST', `/api/rooms/${cS.data.room.id}/join`, { cookie: (await signup('Sid')).cookie });
await DB.prepare('UPDATE rooms SET updated_at = ? WHERE id = ?').bind(Date.now() - 8 * 24 * 3600 * 1000, cS.data.room.id).run();

const G = await signup('Gus');
sent.length = 0;
const rG = await quickJoin(G);
check('quick join picks the room with the fewest seats left (Eve 2/3 over Ada 1/5)',
  rG.data.room_id === roomE && rG.data.joined === true, rG.data);
check('a full host-made room does not start itself', rG.data.started === false
  && !(await DB.prepare('SELECT 1 FROM games WHERE id = ?').bind(roomE).first()));
sent.forEach(m => { m.__kind = kindOf(m); });
const full = sent.filter(m => m.__kind === 'lobby_full');
check('the host of the lobby that just filled gets one "your lobby is full" email',
  full.length === 1 && full[0].to === E.email, sent.map(m => `${m.to}: ${m.subject}`));
check('it names the lobby, links into it and carries an unsubscribe',
  /Eve room/.test(full[0]?.subject ?? '') && (full[0]?.html ?? '').includes(`?room=${roomE}`)
  && /unsubscribe/.test(full[0]?.headers?.['List-Unsubscribe'] ?? ''));
sent.length = 0;
await mail.sweepFullLobbies(env);
check('the sweep does not mail a host who already heard', sent.length === 0, sent.map(m => m.subject));

const B = await signup('Bea');
const rB = await quickJoin(B);
check('with Eve full, password and stale rooms skipped, the next player lands in Ada room',
  rB.data.room_id === roomA, { got: rB.data.room_id, roomA, locked: cP.data.room.id, stale: cS.data.room.id });

const C = await signup('Cal');
const D = await signup('Dot');
await quickJoin(C);
await quickJoin(D);
check('Ada room has 4 of 5 before the last seat', (await members(roomA)) === 4);
check('no game yet', !(await DB.prepare('SELECT 1 FROM games WHERE id = ?').bind(roomA).first()));

sent.length = 0;
const H = await signup('Hal');
sent.length = 0;   // drop Hal's welcome
const rH = await quickJoin(H);
check('the fifth player fills the room and it starts itself', rH.data.room_id === roomA && rH.data.started === true, rH.data);
const game = await DB.prepare('SELECT status FROM games WHERE id = ?').bind(roomA).first();
const room = await DB.prepare('SELECT status FROM rooms WHERE id = ?').bind(roomA).first();
check('games row exists and the room is in progress', !!game && room.status === 'in_progress', { game, room });
check('the Room DO was told the game started', doCalls.some(c => c.id === roomA && c.path === '/game-started'));
sent.forEach(m => { m.__kind = kindOf(m); });
const started = sent.filter(m => m.__kind === 'game_started');
check('all 5 players get one "has begun" email', started.length === 5 && new Set(started.map(m => m.to)).size === 5,
  started.map(m => m.to));
const unsubHeader = started[0]?.headers?.['List-Unsubscribe'];
check('game email carries List-Unsubscribe + one-click POST headers',
  /^<https:\/\/orbital-empire\.com\/api\/email\/unsubscribe\?t=/.test(unsubHeader ?? '')
  && started[0]?.headers?.['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click', started[0]?.headers);
check('game email links straight into the room', started[0]?.html.includes(`?room=${roomA}`));

const again = await (await import('../worker/lobby.js')).startGame(env, roomA);
check('starting an already-started room is refused, not re-seeded', !!again.error);

// Quick join never seats a sixth player in a full room.
const I = await signup('Ivy');
const rI = await quickJoin(I);
check('with every open room full, the next player gets a fresh room', rI.data.created === true && rI.data.room_id !== roomA);
check('Ada room still has exactly 5 members', (await members(roomA)) === 5);

// ---- full-lobby backfill sweep ---------------------------------------------

async function directLobby(host, name, max, others, { quick = false } = {}) {
  const c = await call('POST', '/api/rooms', { cookie: host.cookie, body: { name, max_players: max } });
  const id = c.data.room.id;
  if (quick) await DB.prepare('UPDATE rooms SET quick_join = 1 WHERE id = ?').bind(id).run();
  for (const u of others) {
    await DB.prepare('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)').bind(id, u.id, Date.now()).run();
  }
  return id;
}
const Q1 = await signup('Quin');
const Q2 = await signup('Rae');
const Q3 = await signup('Ula');
const Q4 = await signup('Vic');
const oldFull = await directLobby(Q1, 'Old full', 2, [Q2]);
const optOut = await directLobby(Q3, 'Opted out', 2, [Q4]);
await DB.prepare('UPDATE users SET email_games = 0 WHERE id = ?').bind(Q3.id).run();
const halfFull = await directLobby(Q2, 'Half full', 3, [Q4]);
const stuckQuick = await directLobby(Q4, 'Stuck quick', 2, [Q1], { quick: true });
sent.length = 0;
await mail.sweepFullLobbies(env);
sent.forEach(m => { m.__kind = kindOf(m); });
const bf = sent.filter(m => m.__kind === 'lobby_full');
check('backfill: the host of a lobby that filled earlier gets the email', bf.length === 1 && bf[0].to === Q1.email,
  sent.map(m => `${m.to}: ${m.subject}`));
check('backfill: a host with game mail off gets nothing', !sent.some(m => m.to === Q3.email));
check('backfill: a lobby that is not full is left alone', !sent.some(m => /Half full/.test(m.subject)));
check('backfill: a full Quick Join room is started, not mailed about',
  !!(await DB.prepare('SELECT 1 FROM games WHERE id = ?').bind(stuckQuick).first()));
sent.length = 0;
await mail.sweepFullLobbies(env);
await mail.sweepFullLobbies(env);
check('the sweep never repeats itself, including for the opted-out host', sent.filter(m => /is full/.test(m.subject)).length === 0,
  sent.map(m => m.subject));
const skipped = await DB.prepare("SELECT ok, error FROM email_log WHERE dedupe_key = ?").bind(`lobby_full:${optOut}`).first();
check('the opted-out host is recorded as skipped so the sweep stops asking', skipped?.ok === 0 && skipped?.error === 'skipped', skipped);
void oldFull;
// Out of the way: an open 2/3 lobby would (correctly) win every later
// Quick Join below, which is not what those checks are about.
await DB.prepare('DELETE FROM rooms WHERE id = ?').bind(halfFull).run();

// ---- unsubscribe -----------------------------------------------------------

const token = new URL(unsubHeader.slice(1, -1)).searchParams.get('t');
const who = await mail.readUnsubscribeToken(env, token);
const bad = await call('GET', `/api/email/unsubscribe?t=${token.slice(0, -2)}xx`);
check('a tampered unsubscribe token is refused', bad.status === 400);
const one = await call('POST', `/api/email/unsubscribe?t=${token}`);
const pref = await DB.prepare('SELECT email_games FROM users WHERE id = ?').bind(who.userId).first();
check('one-click POST unsubscribe turns game mail off', one.status === 200 && pref.email_games === 0, { one, pref });
const page = await call('GET', `/api/email/unsubscribe?t=${token}`);
check('the GET link shows a confirmation page', page.status === 200 && /Unsubscribed/.test(page.data));

// ---- game over -------------------------------------------------------------

// The winner: any player in Ada room who did NOT just unsubscribe.
const W = [H, A, B, C, D].find(u => u.id !== who.userId);
const hal = await DB.prepare('SELECT id FROM game_factions WHERE game_id = ? AND user_id = ?').bind(roomA, W.id).first();
await DB.prepare(`UPDATE games SET status = 'completed', winner_faction_id = ?, victory_type = 'domination', completed_at = ? WHERE id = ?`)
  .bind(hal.id, Date.now(), roomA).run();
sent.length = 0;
await mail.sendGameOver(env, roomA);
await mail.sendGameOver(env, roomA);
sent.forEach(m => { m.__kind = kindOf(m); });
check('game over mails the 4 still subscribed, once each (one unsubscribed above)', sent.length === 4,
  sent.map(m => `${m.to}: ${m.subject}`));
const halMail = sent.find(m => m.to === W.email);
check('the winner is told they won', !!halMail && /^You won/.test(halMail.subject), halMail?.subject);
const other = sent.find(m => m.to !== W.email);
check('the others are told who won and how', !!other && other.text.includes('took control of most of the worlds'), other?.text);

// ---- password reset --------------------------------------------------------

sent.length = 0;
const nobody = await call('POST', '/api/auth/forgot', { body: { email: 'nobody@example.com' } });
check('forgot for an unknown address answers ok and sends nothing', nobody.status === 200 && nobody.data.ok === true && sent.length === 0);
const second = await call('POST', '/api/auth/login', { body: { email: A.email, password: 'password123' } });
const forgot = await call('POST', '/api/auth/forgot', { body: { email: A.email.toUpperCase() } });
check('forgot for a real address answers the same and sends one email', forgot.status === 200 && sent.length === 1);
const link = /https:\/\/orbital-empire\.com\/reset-password\?token=([A-Za-z0-9_-]+)/.exec(sent[0]?.text ?? '')?.[1];
check('the reset email contains a reset link', !!link);
const stored = await DB.prepare('SELECT token_hash FROM password_resets').all();
check('the raw token is never stored', !stored.results.some(r => r.token_hash === link));

const short = await call('POST', '/api/auth/reset', { body: { token: link, password: 'short' } });
check('a too-short new password is refused and the token survives', short.status === 400
  && (await DB.prepare('SELECT used_ms FROM password_resets').first()).used_ms == null);
const wrong = await call('POST', '/api/auth/reset', { body: { token: 'x'.repeat(43), password: 'newpassword1' } });
check('a made-up token is refused', wrong.status === 400 && wrong.data.error.code === 'invalid_token');
const ok = await call('POST', '/api/auth/reset', { body: { token: link, password: 'newpassword1' } });
check('the real token sets the password and signs this browser in', ok.status === 200 && !!ok.cookie, ok.data);
const reuse = await call('POST', '/api/auth/reset', { body: { token: link, password: 'another-pass1' } });
check('the same token does not work twice', reuse.status === 400);
const oldSession = await call('GET', '/api/auth/me', { cookie: second.cookie });
check('every other session was signed out', oldSession.status === 401, oldSession.status);
const loginOld = await call('POST', '/api/auth/login', { body: { email: A.email, password: 'password123' } });
const loginNew = await call('POST', '/api/auth/login', { body: { email: A.email, password: 'newpassword1' } });
check('the old password no longer works and the new one does', loginOld.status === 401 && loginNew.status === 200);

// Expiry.
sent.length = 0;
await call('POST', '/api/auth/forgot', { body: { email: B.email } });
const bLink = /token=([A-Za-z0-9_-]+)/.exec(sent[0]?.text ?? '')?.[1];
await DB.prepare('UPDATE password_resets SET expires_ms = ? WHERE user_id = ?').bind(Date.now() - 1, B.id).run();
const expired = await call('POST', '/api/auth/reset', { body: { token: bLink, password: 'newpassword1' } });
check('an expired token is refused', expired.status === 400);

// Rate limit: 3 per 15 minutes per account (one already spent above on Bea).
sent.length = 0;
for (let i = 0; i < 4; i++) await call('POST', '/api/auth/forgot', { body: { email: B.email } });
check('at most 3 reset emails per account per 15 minutes', sent.length === 2, sent.length);

// ---- email prefs -----------------------------------------------------------

// Someone the unsubscribe step above did not touch (which player that
// hit depends on random user ids), and not Dot, who reads two games below.
const X = [C, B, A].find(u => u.id !== who.userId);
const prefs = await call('GET', '/api/users/me/email-prefs', { cookie: X.cookie });
check('prefs default to on and report the address', prefs.data.herald === true && prefs.data.games === true && prefs.data.address === X.email, prefs.data);
const patched = await call('PATCH', '/api/users/me/email-prefs', { cookie: X.cookie, body: { herald: false } });
check('a player can switch the Herald off', patched.data.herald === false && patched.data.games === true, patched.data);

// ---- the daily Herald by email ---------------------------------------------

// Game 2: Ivy's fresh room, filled by three newcomers and Dot, who is
// already playing in Ada's game. Dot then reads TWO games, and the
// Herald must reach her once, covering both.
const roomI = rI.data.room_id;
for (const nm of ['Jo', 'Kit', 'Lou']) await quickJoin(await signup(nm));
const rDot = await quickJoin(D);
check('a player in a running game can Quick Join a second one', rDot.data.room_id === roomI && rDot.data.started === true, rDot.data);
const g2 = await DB.prepare('SELECT status FROM games WHERE id = ?').bind(roomI).first();
check('the second Quick Join room also filled and started', !!g2, g2);
await DB.prepare(`UPDATE games SET status = 'active' WHERE id IN (?, ?)`).bind(roomA, roomI).run();
const now = Date.now();
for (const gid of [roomA, roomI]) {
  const f = await DB.prepare('SELECT id FROM game_factions WHERE game_id = ? LIMIT 1').bind(gid).first();
  await DB.prepare(`INSERT INTO chronicle_entries (id, game_id, tick_number, kind, actor_faction_id, payload, visibility, created_at_ms)
                    VALUES (?, ?, 1, 'settlement_founded', ?, '{}', 'public', ?)`)
    .bind(`chr_${gid}`, gid, f.id, now - 3600000).run();
}
// Noon Eastern, today.
const noon = (() => {
  for (let h = 0; h < 48; h++) {
    const t = now - (now % 3600000) + h * 3600000;
    const hh = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date(t))) % 24;
    if (hh === 12) return t + 60000;
  }
  return now;
})();
sent.length = 0;
await mail.maybeSendDailyHeraldEmails(env, noon - 3 * 3600000);
check('the Herald does not go out outside its hour', sent.length === 0);
await mail.maybeSendDailyHeraldEmails(env, noon);
await mail.maybeSendDailyHeraldEmails(env, noon + 60000);
sent.forEach(m => { m.__kind = kindOf(m); });
const heralds = sent.filter(m => m.__kind === 'herald');
const readers = new Set(heralds.map(m => m.to));
check('one Herald email per reader per day, however many cron minutes fire', heralds.length === readers.size && heralds.length > 0,
  heralds.map(m => m.to));
check('a reader who switched the Herald off gets none', !readers.has(X.email));
const ivyMail = heralds.find(m => m.to === I.email);
check('Herald email covers the reader game and links into it', !!ivyMail && ivyMail.html.includes(`?room=${roomI}`));
const dotMail = heralds.filter(m => m.to === D.email);
check('a reader in two games gets ONE Herald covering both', dotMail.length === 1
  && dotMail[0].html.includes(`?room=${roomA}`) && dotMail[0].html.includes(`?room=${roomI}`));
check('Herald carries a one-click unsubscribe', /api\/email\/unsubscribe/.test(heralds[0]?.headers?.['List-Unsubscribe'] ?? ''));
check('Herald has a plain-text part naming each game', /TURN \d+/.test(heralds[0]?.text ?? ''), heralds[0]?.text?.slice(0, 200));

// ---- lobby browse / mine summaries -----------------------------------------

const newbie = await signup('Nia');
const br = await call('GET', '/api/lobby/browse', { cookie: newbie.cookie });
const byId = new Map((br.data.games ?? []).map(g => [g.id, g]));
check('browse answers with games', br.status === 200 && byId.size > 0, br.status);
check('a running game reads as live with its turn, not "lobby"', byId.get(roomI)?.phase === 'live'
  && byId.get(roomI)?.current_tick != null, byId.get(roomI));
check('a full host-run lobby reads as full and is not joinable', byId.get(roomE)?.phase === 'full'
  && byId.get(roomE)?.joinable === false, byId.get(roomE));
check('a live game lists its empires with colours', (byId.get(roomI)?.players ?? []).length === 5
  && byId.get(roomI).players.every(p => typeof p.color === 'string'), byId.get(roomI)?.players);
check('a lobby lists its members by name, host marked', (byId.get(roomE)?.players ?? []).some(p => p.is_host && p.name === 'Eve'),
  byId.get(roomE)?.players);
check('password rooms are flagged', byId.get(cP.data.room.id)?.has_password === true);
const mineRes = await call('GET', '/api/lobby/mine', { cookie: D.cookie });
const dGames = mineRes.data.games ?? [];
check('My Games carries the player’s own empire in each running game',
  dGames.length >= 2 && dGames.filter(g => g.phase === 'live').every(g => g.me && g.me.name), dGames.map(g => [g.phase, g.me?.name]));
check('My Games marks membership', dGames.every(g => g.is_member === true));

// ---- raising the seat cap mid-game -----------------------------------------

// Ada hosts roomA (her first Quick Join): running, 5 of 5. Her original
// session died with the password reset, so use the fresh login.
const adaCookie = loginNew.cookie;
const seatsUrl = `/api/lobby/rooms/${roomA}/seats`;
const notHost = await call('PATCH', seatsUrl, { cookie: B.cookie, body: { max_players: 7 } });
check('only the host can open more seats in a running game', notHost.status === 403, notHost.status);
const lower = await call('PATCH', seatsUrl, { cookie: adaCookie, body: { max_players: 4 } });
check('seats cannot be lowered mid-game', lower.status === 400 && lower.data.error.code === 'raise_only', lower.data);
const over = await call('PATCH', seatsUrl, { cookie: adaCookie, body: { max_players: 11 } });
check('seats cannot go past 10', over.status === 400, over.status);
const preStart = await call('PATCH', `/api/lobby/rooms/${roomE}/seats`, { cookie: E.cookie, body: { max_players: 3 } });
check('a lobby that has not started uses its own settings, not this', preStart.status === 409 && preStart.data.error.code === 'not_started', preStart.data);
const raised = await call('PATCH', seatsUrl, { cookie: adaCookie, body: { max_players: 7 } });
check('the host raises a running 5-seat game to 7', raised.status === 200 && raised.data.settings.max_players === 7
  && raised.data.settings.member_count === 5, raised.data);
const late1 = await signup('Lia');
const late2 = await signup('Mo');
const late3 = await signup('Ned');
const brLate = await call('GET', '/api/lobby/browse', { cookie: late1.cookie });
const aCard = (brLate.data.games ?? []).find(g => g.id === roomA);
check('Browse lists it as joinable in progress with 2 open seats', aCard?.phase === 'live' && aCard?.joinable === true && aCard?.open_seats === 2, aCard);
const j1 = await call('POST', `/api/rooms/${roomA}/join`, { cookie: late1.cookie });
const j2 = await call('POST', `/api/rooms/${roomA}/join`, { cookie: late2.cookie });
const j3 = await call('POST', `/api/rooms/${roomA}/join`, { cookie: late3.cookie });
check('two newcomers take the two new seats', j1.status === 200 && j2.status === 200 && (await members(roomA)) === 7, [j1.status, j2.status]);
check('the next one is turned away: the game is full again', j3.status === 403 && j3.data.error.code === 'room_full', j3.data);
await DB.prepare(`UPDATE games SET status = 'completed' WHERE id = ?`).bind(roomA).run();
const done = await call('PATCH', seatsUrl, { cookie: adaCookie, body: { max_players: 8 } });
check('a finished game cannot be reopened for seats', done.status === 409, done.status);
await DB.prepare(`UPDATE games SET status = 'active' WHERE id = ?`).bind(roomA).run();

// ---- Auto-load on launch ---------------------------------------------------

const noAuto = await call('GET', '/api/users/me/rooms', { cookie: D.cookie });
check('by default no game auto-loads (launch lands on the lobby)', noAuto.data.autoload_room_id === null, noAuto.data.autoload_room_id);
const setA = await call('PUT', '/api/users/me/autoload', { cookie: D.cookie, body: { room_id: roomI } });
const afterA = await call('GET', '/api/users/me/rooms', { cookie: D.cookie });
check('a player can set one of their games to auto-load', setA.status === 200 && afterA.data.autoload_room_id === roomI, afterA.data);
const setB = await call('PUT', '/api/users/me/autoload', { cookie: D.cookie, body: { room_id: roomA } });
const mineAuto = await call('GET', '/api/lobby/mine', { cookie: D.cookie });
check('switching another game on replaces it (only one opens on launch)', setB.status === 200 && mineAuto.data.autoload_room_id === roomA);
const notMine = await call('PUT', '/api/users/me/autoload', { cookie: D.cookie, body: { room_id: roomE } });
check('a game you are not in cannot be set to auto-load', notMine.status === 404);
const off = await call('PUT', '/api/users/me/autoload', { cookie: D.cookie, body: { room_id: null } });
const afterOff = await call('GET', '/api/users/me/rooms', { cookie: D.cookie });
check('switching it off returns launch to the lobby', off.status === 200 && afterOff.data.autoload_room_id === null);

// ---- the second-visit Discord invite ---------------------------------------

const V = await signup('Val');
const v1 = await call('GET', '/api/auth/me', { cookie: V.cookie });
check('a brand-new player is not invited on their first visit', v1.data.user.invite_discord === null, v1.data.user);
const v1b = await call('POST', '/api/auth/login', { body: { email: V.email, password: 'password123' } });
check('coming back within 30 minutes is the same visit: still no invite', v1b.data.user.invite_discord === null);
await DB.prepare('UPDATE users SET last_visit_ms = ? WHERE id = ?').bind(Date.now() - 31 * 60 * 1000, V.id).run();
const v2 = await call('GET', '/api/auth/me', { cookie: V.cookie });
check('the second visit brings the invite, with the Discord link', v2.data.user.invite_discord === 'https://discord.gg/h4G4bTbDfe', v2.data.user);
const v2b = await call('GET', '/api/auth/me', { cookie: V.cookie });
check('it stays up until answered (a reload inside the visit still shows it)', v2b.data.user.invite_discord === 'https://discord.gg/h4G4bTbDfe');
await call('POST', '/api/users/me/discord-invite', { cookie: V.cookie, body: { action: 'joined' } });
await DB.prepare('UPDATE users SET last_visit_ms = ? WHERE id = ?').bind(Date.now() - 31 * 60 * 1000, V.id).run();
const v3 = await call('GET', '/api/auth/me', { cookie: V.cookie });
const vrow = await DB.prepare('SELECT discord_prompt_action, visit_count FROM users WHERE id = ?').bind(V.id).first();
check('once answered it never shows again, and the answer is kept', v3.data.user.invite_discord === null && vrow.discord_prompt_action === 'joined', vrow);
// Backfill: an account that existed before this shipped starts at 1 visit.
await DB.prepare('UPDATE users SET visit_count = 1, last_visit_ms = NULL, discord_prompt_ms = NULL WHERE id = ?').bind(B.id).run();
const bLogin = await call('POST', '/api/auth/login', { body: { email: B.email, password: 'password123' } });
check('backfill: an existing player is invited on their next visit', bLogin.data.user.invite_discord === 'https://discord.gg/h4G4bTbDfe', bLogin.data.user);
await DB.prepare("UPDATE users SET email = 'agent+sim@agents.orbital.local', visit_count = 5, discord_prompt_ms = NULL WHERE id = ?").bind(Q2.id).run();
const agentMe = await call('GET', '/api/auth/me', { cookie: Q2.cookie });
check('agent accounts (the screenshot harness) are never invited', agentMe.data.user.invite_discord === null);

// ---- no binding, no mail ---------------------------------------------------

const quiet = await mail.sendEmail({ DB }, { to: 'x@example.com', kind: 't', subject: 's', html: 'h', text: 't' });
check('without an EMAIL binding (staging) nothing is sent', quiet.sent === false && quiet.reason === 'not_configured');
const agent = await mail.sendEmail(env, { to: 'agent+x@agents.orbital.local', kind: 't', subject: 's', html: 'h', text: 't' });
check('agent accounts never receive mail', agent.sent === false);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
