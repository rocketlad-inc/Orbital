// ============================================================
// Per-game Discord feeds -- drives the REAL worker over SimD1 with a fake
// Discord API that records every call.
//
// Lorne, 2026-10-01: "We've gotta come up with a better solution for the
// herald and discord game feed... all games are running on the same discord
// bot... I also think generally you should have to turn on your game feed"
// -- then "Forum channel, host turns it on, build it". A 1-minute game had
// sent about 50 posts overnight.
//
// Pins down:
//   * a game posts NOTHING until its host turns the feed on (and only the
//     host can), and nothing without a forum configured
//   * 'headlines' keeps wars / big battles / the Herald, drops the rest;
//     'all' keeps everything
//   * each game gets its OWN forum post, made on its first post, with a
//     one-line pointer in the shared channel; a second game, a second post
//   * following adds the player to the thread (linked accounts only)
//   * a fast game is capped in wall-clock time and says what it skipped
//   * the Herald prints into the game's thread, and not at all when off
//
// Run: npm run sim:feed
// ============================================================

import worker from '../worker/index.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { postChannelEmbed } from '../worker/discord.js';
import { runDigestForGame } from '../worker/digest.js';
import { FAST_CAP } from '../worker/gameFeed.js';

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures++; if (detail !== undefined) console.log(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); }
}

// ---- fake Discord -------------------------------------------------------------
const calls = [];
let nextId = 1000;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url?.url ?? url);
  if (!u.startsWith('https://discord.com/api/')) return realFetch(url, init);
  const path = u.replace(/^https:\/\/discord\.com\/api\/v\d+/, '');
  let body = null;
  if (typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch { body = init.body; } }
  else if (init.body && typeof init.body.get === 'function') body = { form: true, payload: JSON.parse(init.body.get('payload_json')) };
  calls.push({ method: init.method ?? 'GET', path, body });
  if (path === '/channels/123456789012/threads') return Response.json({ id: `thr${nextId++}`, guild_id: 'guild1' });
  return Response.json({ id: `msg${nextId++}` });
};
const posts = (pred = () => true) => calls.filter(c => c.method === 'POST' && /\/messages$/.test(c.path) && pred(c));
const inThread = (t) => posts(c => c.path === `/channels/${t}/messages`);

const ROOM = {
  idFromName: (n) => n,
  get: () => ({ async fetch(url) { const p = new URL(typeof url === 'string' ? url : url.url).pathname; return p === '/settings' ? Response.json({}) : Response.json({ ok: true }); } }),
};
const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
DB.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
for (const m of MIGRATIONS) DB.db.prepare('INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, 0)').run(m.name);
const env = { DB, ROOM, EMAIL_LINK_SECRET: 'sim-secret', DISCORD_BOT_TOKEN: 'bot', DISCORD_CHANNEL_ID: 'main1' };
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
async function game(host, guest, name, tickMs) {
  const c = await call('POST', '/api/rooms', { cookie: host.cookie, body: { name, max_players: 2 } });
  const id = c.data.room.id;
  await call('POST', `/api/rooms/${id}/join`, { cookie: guest.cookie });
  const s = await call('POST', `/api/lobby/rooms/${id}/start`, { cookie: host.cookie });
  if (s.status !== 200) throw new Error(`start ${s.status} ${JSON.stringify(s.data)}`);
  await DB.prepare(`UPDATE games SET status = 'active', tick_interval_ms = ? WHERE id = ?`).bind(tickMs, id).run();
  return id;
}
const embed = (t) => ({ title: t, description: 'x' });
const feedRow = (g) => DB.prepare('SELECT * FROM game_feeds WHERE game_id = ?').bind(g).first();

const A = await signup('Ada');
const B = await signup('Bex');
await DB.prepare("UPDATE users SET discord_id = '5551' WHERE id = ?").bind(A.id).run();
const g1 = await game(A, B, 'Slow War', 3_600_000);

// ---- off by default, host only, needs a forum -----------------------------------
let r = await call('GET', `/api/games/${g1}/feed`, { cookie: B.cookie });
check('a new game\'s feed is off', r.status === 200 && r.data.level === 'off', r.data);
// A linked player alone used to switch the old channel on.
await postChannelEmbed(env, embed('war!'), g1, { headline: true });
check('with the feed off, nothing posts, even a headline, even with a linked player', posts().length === 0, calls);
r = await call('PUT', `/api/games/${g1}/feed`, { cookie: B.cookie, body: { level: 'all' } });
check('a non-host cannot turn it on', r.status === 403, r);
r = await call('PUT', `/api/games/${g1}/feed`, { cookie: A.cookie, body: { level: 'loud' } });
check('only off / headlines / all', r.status === 400, r);
r = await call('PUT', `/api/games/${g1}/feed`, { cookie: A.cookie, body: { level: 'headlines' } });
check('the host turns it on (headlines)', r.status === 200 && r.data.level === 'headlines' && r.data.forum_configured === false, r.data);
await postChannelEmbed(env, embed('war!'), g1, { headline: true });
check('no forum configured: still nothing, and never the old shared channel', posts().length === 0, calls);

await DB.prepare("INSERT INTO bot_settings (key, value, updated_ms) VALUES ('feed_forum_channel_id', '\"123456789012\"', 0)").run();

// ---- first headline: the thread is made, the pointer posts ------------------------
r = await call('POST', `/api/games/${g1}/wars/declare`, { cookie: A.cookie, body: { target_faction_id: (await DB.prepare('SELECT id FROM game_factions WHERE game_id = ? AND user_id = ?').bind(g1, B.id).first()).id } });
check('a war is declared', r.status === 200, r);
const made = calls.filter(c => c.method === 'POST' && c.path === '/channels/123456789012/threads');
check('the first post makes the game\'s forum post, named for the game', made.length === 1 && made[0].body.name === 'Slow War', made);
const t1 = (await feedRow(g1)).thread_id;
check('...and points to it once in the shared channel', posts(c => c.path === '/channels/main1/messages' && /Slow War/.test(c.body.content) && c.body.content.includes(`<#${t1}>`)).length === 1);
check('the war is announced in the game\'s thread as a headline', inThread(t1).some(c => /declares war/.test(c.body.embeds?.[0]?.title ?? '')), inThread(t1));

const before = inThread(t1).length;
await postChannelEmbed(env, embed('a law expired'), g1, { headline: false });
check('headlines: a routine post is dropped', inThread(t1).length === before);
await call('PUT', `/api/games/${g1}/feed`, { cookie: A.cookie, body: { level: 'all' } });
await postChannelEmbed(env, embed('a law expired'), g1, { headline: false });
check('everything: the routine post goes in', inThread(t1).length === before + 1);
r = await call('GET', `/api/games/${g1}/feed`, { cookie: B.cookie });
check('players get a link to the thread', r.data.thread_url === `https://discord.com/channels/guild1/${t1}`, r.data);
check('...and the Orbital Discord invite, for anyone not on the server yet', /^https:\/\/discord\.gg\//.test(r.data.discord_invite ?? ''), r.data);

// ---- following ---------------------------------------------------------------------
r = await call('POST', `/api/games/${g1}/feed/follow`, { cookie: B.cookie, body: { follow: true } });
check('an unlinked player is told to link Discord first', r.status === 409 && r.data?.error?.code === 'discord_not_linked', r);
r = await call('POST', `/api/games/${g1}/feed/follow`, { cookie: A.cookie, body: { follow: true } });
check('a linked player follows: the bot adds them to the thread',
  r.data.following === true && calls.some(c => c.method === 'PUT' && c.path === `/channels/${t1}/thread-members/5551`), r.data);
r = await call('POST', `/api/games/${g1}/feed/follow`, { cookie: A.cookie, body: { follow: false } });
check('...and unfollowing removes them',
  r.data.following === false && calls.some(c => c.method === 'DELETE' && c.path === `/channels/${t1}/thread-members/5551`), r.data);

// ---- a second game is a second post ----------------------------------------------------
const C = await signup('Cal');
const D = await signup('Dov');
const g2 = await game(C, D, 'Speed Run', 30_000);
await call('PUT', `/api/games/${g2}/feed`, { cookie: C.cookie, body: { level: 'all' } });
// Cal follows BEFORE the thread exists: the thread's creation adds them.
await DB.prepare("UPDATE users SET discord_id = '7772' WHERE id = ?").bind(C.id).run();
await call('POST', `/api/games/${g2}/feed/follow`, { cookie: C.cookie, body: { follow: true } });
for (let i = 0; i < FAST_CAP + 2; i++) await postChannelEmbed(env, embed(`event ${i}`), g2);
const t2 = (await feedRow(g2)).thread_id;
check('a second game gets its own forum post', t2 && t2 !== t1);
check('an early follower is added when the thread is made', calls.some(c => c.method === 'PUT' && c.path === `/channels/${t2}/thread-members/7772`));
check(`a 30-second game is capped: ${FAST_CAP} of ${FAST_CAP + 2} posted`, inThread(t2).length === FAST_CAP, inThread(t2).length);
check('the other game is untouched by it', !inThread(t1).some(c => /event/.test(c.body.embeds?.[0]?.title ?? '')));
// The window turns over.
await DB.prepare('UPDATE game_feeds SET window_start_ms = window_start_ms - 3600000 WHERE game_id = ?').bind(g2).run();
await postChannelEmbed(env, embed('after the window'), g2);
const tail = inThread(t2).slice(-2);
check('when the window turns over, it says what it skipped, then posts',
  /2 more updates skipped/.test(tail[0]?.body?.content ?? '') && tail[1]?.body?.embeds?.[0]?.title === 'after the window', tail);
const slowBefore = inThread(t1).length;
for (let i = 0; i < FAST_CAP + 3; i++) await postChannelEmbed(env, embed(`slow ${i}`), g1);
check('an hour-a-tick game is not capped', inThread(t1).length === slowBefore + FAST_CAP + 3);

// ---- the Herald ----------------------------------------------------------------------------
const g3 = await game(B, C, 'Quiet One', 3_600_000);
let h = await runDigestForGame(env, { id: g3, current_tick: 5, name: 'Quiet One' }, { force: true });
check('the Herald does not print for a game whose feed is off', h.posted === false && h.reason === 'feed_off', h);
h = await runDigestForGame(env, { id: g1, current_tick: 5, name: 'Slow War' }, { force: true });
check('the Herald prints into the game\'s own thread', h.posted === true
  && inThread(t1).some(c => /HERALD/.test(JSON.stringify(c.body))), h);
check('no Herald ever goes to the shared channel', !posts(c => c.path === '/channels/main1/messages').some(c => /HERALD/.test(JSON.stringify(c.body))));
r = await call('POST', `/api/games/${g3}/admin/digest-now`, { cookie: B.cookie });
check('"Publish Herald now" on a feed-off game explains itself', r.status === 409 && r.data?.error?.code === 'feed_off', r);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
