// ============================================================
// A game's Discord feed in the HOST'S OWN server -- drives the REAL worker
// over SimD1 with a fake Discord that records every call.
//
// A player asked to use the bot in their own server (2026-10-06); it only
// knew Lorne's. Lorne: a Commander's Commission feature. One click:
// Discord's consent screen adds the bot and picks the channel.
//
// Pins down:
//   * only the HOST, and only while holding the Commission, can connect
//   * the connect hands off to Discord with bot + webhook.incoming and the
//     bot's permissions; the callback is single-use
//   * connecting stores the channel, turns an off feed on, removes the
//     helper webhook, and says hello in the channel with a way into the game
//   * posts then go to the host's channel (a text channel directly, a
//     forum as one post per game), not the Orbital forum
//   * a refunded Commission falls back to the Orbital forum by itself
//   * only the host disconnects; a cancelled consent connects nothing
//
// Run: npm run sim:serverfeed
// ============================================================

import worker from '../worker/index.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { postChannelEmbed } from '../worker/discord.js';

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures++; if (detail !== undefined) console.log(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 600)}`); }
}

// ---- fake Discord -------------------------------------------------------------
const calls = [];
let nextId = 1000;
let channelType = 0;               // 0 = text, 15 = forum
const CH = '777000111222';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url?.url ?? url);
  if (!u.startsWith('https://discord.com/')) return realFetch(url, init);
  if (u === 'https://discord.com/api/oauth2/token') {
    calls.push({ method: 'POST', path: '/oauth2/token' });
    return Response.json({
      access_token: 'at', token_type: 'Bearer', scope: 'bot applications.commands webhook.incoming',
      webhook: { id: 'wh1', token: 'whtok', channel_id: CH, guild_id: 'g9' },
      guild: { id: 'g9', name: 'Crimson Club' },
    });
  }
  const path = u.replace(/^https:\/\/discord\.com\/api(\/v\d+)?/, '');
  let body = null;
  if (typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch { body = init.body; } }
  calls.push({ method: init.method ?? 'GET', path, body });
  if ((init.method ?? 'GET') === 'GET' && path === `/channels/${CH}`) {
    return Response.json({ id: CH, name: 'orbital-news', type: channelType, guild_id: 'g9' });
  }
  if (/\/threads$/.test(path)) return Response.json({ id: `thr${nextId++}`, guild_id: path.includes(CH) ? 'g9' : 'guild1' });
  if (init.method === 'DELETE') return new Response(null, { status: 204 });
  return Response.json({ id: `msg${nextId++}` });
};
const posts = (pred = () => true) => calls.filter(c => c.method === 'POST' && /\/messages$/.test(c.path) && pred(c));

const ROOM = {
  idFromName: (n) => n,
  get: () => ({ async fetch(url) { const p = new URL(typeof url === 'string' ? url : url.url).pathname; return p === '/settings' ? Response.json({}) : Response.json({ ok: true }); } }),
};
const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
DB.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
for (const m of MIGRATIONS) DB.db.prepare('INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, 0)').run(m.name);
const env = {
  DB, ROOM, EMAIL_LINK_SECRET: 'sim-secret', DISCORD_BOT_TOKEN: 'bot', DISCORD_CHANNEL_ID: 'main1',
  DISCORD_CLIENT_ID: 'app123', DISCORD_CLIENT_SECRET: 'shh', PUBLIC_ORIGIN: 'https://orbital-empire.com',
};
const execCtx = { waitUntil() {}, passThroughOnException() {} };

async function call(method, path, { body, cookie } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  const res = await worker.fetch(new Request(`https://orbital-empire.com${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
  }), env, execCtx);
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { data = text; }
  const sc = res.headers.get('set-cookie');
  return { status: res.status, data, location: res.headers.get('location'), cookie: sc ? sc.split(';')[0] : null };
}
async function signup(name) {
  const r = await call('POST', '/api/auth/signup', { body: { email: `${name.toLowerCase()}@example.com`, password: 'password123', display_name: name } });
  if (r.status !== 201) throw new Error(`signup ${name} -> ${r.status} ${JSON.stringify(r.data)}`);
  return { name, cookie: r.cookie, id: r.data.user.id };
}
async function game(host, guest, name) {
  const c = await call('POST', '/api/rooms', { cookie: host.cookie, body: { name, max_players: 2 } });
  const id = c.data.room.id;
  await call('POST', `/api/rooms/${id}/join`, { cookie: guest.cookie });
  const s = await call('POST', `/api/lobby/rooms/${id}/start`, { cookie: host.cookie });
  if (s.status !== 200) throw new Error(`start ${s.status} ${JSON.stringify(s.data)}`);
  await DB.prepare(`UPDATE games SET status = 'active', tick_interval_ms = 3600000 WHERE id = ?`).bind(id).run();
  return id;
}
const grant = (u) => DB.prepare(`INSERT OR IGNORE INTO user_entitlements (user_id, sku, source, granted_at) VALUES (?, 'cosmetics_v1', 'admin', 0)`).bind(u.id).run();
const revoke = (u) => DB.prepare(`DELETE FROM user_entitlements WHERE user_id = ?`).bind(u.id).run();
const feedRow = (g) => DB.prepare('SELECT * FROM game_feeds WHERE game_id = ?').bind(g).first();
const embed = (t) => ({ title: t, description: 'x' });
/** Run the whole connect: start (as host) -> Discord -> callback. */
async function connect(host, g) {
  const start = await call('GET', `/api/games/${g}/feed/connect`, { cookie: host.cookie });
  const state = start.location ? new URL(start.location).searchParams.get('state') : null;
  const cb = await call('GET', `/api/discord/feed/callback?code=abc&state=${encodeURIComponent(state ?? '')}&guild_id=g9`);
  return { start, state, cb };
}

await DB.prepare("INSERT INTO bot_settings (key, value, updated_ms) VALUES ('feed_forum_channel_id', '\"123456789012\"', 0)").run();
const H = await signup('Crimson');
const M = await signup('Moria');
const g = await game(H, M, 'Crimson Wars');

// ---- the gate ------------------------------------------------------------------
let r = await call('GET', `/api/games/${g}/feed/connect`, { cookie: H.cookie });
check('a host without the Commission is told it is a Commission feature',
  r.status === 400 && /Commission/.test(String(r.data)) && !r.location, String(r.data).slice(0, 200));
r = await call('GET', `/api/games/${g}/feed`, { cookie: M.cookie });
check("the feed view says whether the host holds it (for the gift pitch)",
  r.data.host_holds_commission === false && r.data.host_name === 'Crimson' && r.data.server === null, r.data);

await grant(M);
r = await call('GET', `/api/games/${g}/feed/connect`, { cookie: M.cookie });
check('a player who is not the host cannot connect, Commission or not', r.status === 400 && /host/.test(String(r.data)) && !r.location);

await grant(H);
r = await call('GET', `/api/games/${g}/feed/connect`, { cookie: H.cookie });
const loc = r.location ? new URL(r.location) : null;
check('the host with the Commission is sent to Discord to pick a server and channel',
  r.status === 302 && loc?.hostname === 'discord.com'
    && loc.searchParams.get('scope') === 'bot applications.commands webhook.incoming'
    && loc.searchParams.get('client_id') === 'app123'
    && loc.searchParams.get('redirect_uri') === 'https://orbital-empire.com/api/discord/feed/callback'
    && Number(loc.searchParams.get('permissions')) > 0,
  r.location);

// ---- connecting a TEXT channel ------------------------------------------------------
calls.length = 0;
const c1 = await connect(H, g);
let row = await feedRow(g);
check('connected: the page says where it posts', c1.cb.status === 200 && /#orbital-news in Crimson Club/.test(String(c1.cb.data)), String(c1.cb.data).slice(0, 300));
check('the channel is stored, by whose Commission', row.server_channel_id === CH && row.server_guild_name === 'Crimson Club'
  && row.server_channel_kind === 'text' && row.server_by_user_id === H.id, row);
check('connecting turned the (off) feed on', row.level === 'all', row.level);
check('the helper webhook Discord made is deleted again', calls.some(c => c.method === 'DELETE' && c.path === '/webhooks/wh1/whtok'));
const hello = posts(c => c.path === `/channels/${CH}/messages`);
check('the bot says hello in the channel: the game, the Commission, a way to join',
  hello.length === 1 && /Crimson Wars/.test(hello[0].body.content) && /Commission/.test(hello[0].body.content)
    && /invite=|from=discord-feed/.test(hello[0].body.content), hello);

const replay = await call('GET', `/api/discord/feed/callback?code=abc&state=${encodeURIComponent(c1.state)}`);
check('the callback is single-use', /expired/.test(String(replay.data)));

calls.length = 0;
await postChannelEmbed(env, embed('war!'), g, { headline: true });
check("the game's posts now go to the host's channel", posts(c => c.path === `/channels/${CH}/messages`).length === 1, calls);
check('...and not to the Orbital forum', !calls.some(c => c.path === '/channels/123456789012/threads'), calls);

r = await call('GET', `/api/games/${g}/feed`, { cookie: M.cookie });
check('players see where the feed posts', r.data.server?.channel_name === 'orbital-news' && r.data.server?.active === true
  && r.data.server?.url === `https://discord.com/channels/g9/${CH}`, r.data.server);

// ---- the Commission lapses -------------------------------------------------------
await revoke(H);
calls.length = 0;
await postChannelEmbed(env, embed('war again'), g, { headline: true });
check('a refunded Commission: posts fall back to the Orbital forum',
  calls.some(c => c.path === '/channels/123456789012/threads') && !posts(c => c.path === `/channels/${CH}/messages`).length, calls);
r = await call('GET', `/api/games/${g}/feed`, { cookie: H.cookie });
check('...and the view says the server is paused', r.data.server?.active === false, r.data.server);
await grant(H);

// ---- disconnect -----------------------------------------------------------------
r = await call('DELETE', `/api/games/${g}/feed/server`, { cookie: M.cookie });
check('only the host disconnects', r.status === 403, r);
r = await call('DELETE', `/api/games/${g}/feed/server`, { cookie: H.cookie });
row = await feedRow(g);
check('the host disconnects: back to the Orbital forum', r.status === 200 && r.data.server === null && row.server_channel_id === null, r.data);

// ---- a FORUM channel ----------------------------------------------------------------
channelType = 15;
calls.length = 0;
const c2 = await connect(H, g);
row = await feedRow(g);
const made = calls.filter(c => c.method === 'POST' && c.path === `/channels/${CH}/threads`);
check('a forum channel gets one post for the game, opened with the hello',
  /Connected/.test(String(c2.cb.data)) && row.server_channel_kind === 'forum' && made.length === 1
    && made[0].body.name === 'Crimson Wars' && /Commission/.test(made[0].body.message.content), made);
calls.length = 0;
await postChannelEmbed(env, embed('battle'), g, { headline: true });
check('...and the game posts inside that post', posts(c => c.path === `/channels/${row.server_thread_id}/messages`).length === 1, calls);

// ---- cancelled on Discord's page ------------------------------------------------------
r = await call('GET', `/api/discord/feed/callback?error=access_denied&state=${g}.zzz`);
check('cancelling on Discord connects nothing', /Nothing was connected/.test(String(r.data)));

// ---- the one-click account link (same state table) -----------------------------------
// Its insert left out the NOT NULL created_at, so it threw on every click
// and has never worked on prod ("Could not start sign-in").
r = await call('GET', '/api/discord/oauth/start', { cookie: M.cookie });
check('"Connect Discord" (one-click account link) hands off to Discord',
  r.status === 302 && new URL(r.location ?? 'x:').hostname === 'discord.com', [r.status, String(r.data).slice(0, 200)]);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
