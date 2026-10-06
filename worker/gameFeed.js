// ============================================================================
// gameFeed.js — each game's Discord feed, in its own forum post.
//
// Every game used to post to ONE channel, switched on by nothing more than
// a single Discord-linked player. With several games running that was one
// interleaved stream nobody could follow, and a 30-second-tick sandbox
// (cuckworld, 2026-09-30) filled it overnight. Lorne's call: a FORUM
// channel, one post per game, and the HOST turns the feed on.
//
// Three rules, all here so no publisher carries its own copy:
//
//   1. OFF UNLESS THE HOST TURNS IT ON. `game_feeds.level` is 'off' by
//      default; 'headlines' passes only posts marked headline (wars, a
//      chancellor elected, a big battle, the Herald); 'all' passes
//      everything the old channel got.
//   2. ONE THREAD PER GAME, made lazily in the forum named by the
//      `feed_forum_channel_id` bot setting on the first post. No forum
//      configured = nothing posts (the old shared channel is never the
//      fallback; that is the behaviour being retired).
//   3. A FAST GAME IS RATE-CAPPED in wall-clock time. Below ten minutes a
//      tick, at most FAST_CAP posts per FAST_WINDOW_MS; what does not fit
//      is counted and summarised in one line when the window turns over.
//
// Following is Discord's own thread membership: the in-game toggle asks
// the bot to add (or remove) a player with a linked account, and anyone
// can follow or leave a post inside Discord directly.
//
// YOUR OWN SERVER (0156, a Commander's Commission feature). A host who
// holds the Commission can send the game's feed to a channel in THEIR
// Discord server instead. One click: Discord's consent screen adds the bot
// and picks the channel in the same step (scopes bot + webhook.incoming;
// the webhook is only how Discord hands us the chosen channel, and is
// deleted again). A forum channel gets one post per game, a text channel
// takes the posts directly. The Commission is checked on EVERY post, so a
// refunded one falls back to the Orbital forum without anyone touching it.
// Linking, DMs and the Orbital forum stay free for everyone.
// ============================================================================

import { json, err, readJson } from './trades.js';
import { FEEDBACK_DISCORD_URL } from './links.js';
import { hasEntitlement } from './store.js';
import { page, discordClientId } from './discordOauth.js';

const DISCORD_API = 'https://discord.com/api/v10';
export const FEED_LEVELS = ['off', 'headlines', 'all'];
export const FAST_TICK_MS = 10 * 60 * 1000;
export const FAST_WINDOW_MS = 10 * 60 * 1000;
export const FAST_CAP = 6;
const GAME_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;

async function botFetch(env, method, path, body) {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  return fetch(`${DISCORD_API}${path}`, {
    method,
    headers: {
      authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      ...(isForm || body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
}

async function forumId(env) {
  try {
    const cfg = await (await import('./botSettings.js')).getSettings(env);
    const id = String(cfg.feed_forum_channel_id ?? '').trim();
    return /^\d{5,30}$/.test(id) ? id : null;
  } catch { return null; }
}

export async function feedRow(env, gameId) {
  return env.DB
    .prepare(`SELECT game_id, level, thread_id, guild_id, window_start_ms, window_posts, suppressed,
                     server_guild_id, server_guild_name, server_channel_id, server_channel_name,
                     server_channel_kind, server_thread_id, server_by_user_id
                FROM game_feeds WHERE game_id = ?`)
    .bind(gameId).first();
}

/** Does this game's feed take a post of this weight? Pure. */
export function levelAdmits(level, headline) {
  if (level === 'all') return true;
  if (level === 'headlines') return !!headline;
  return false;
}

/** The wall-clock cap for fast games. Pure: given the row, the game's
 *  cadence and now, say whether to post and what to write back. */
export function rateDecision(row, tickMs, now) {
  if (!(tickMs > 0 && tickMs < FAST_TICK_MS)) {
    return { post: true, write: null, skippedNote: 0 };
  }
  let start = Number(row?.window_start_ms ?? 0);
  let posts = Number(row?.window_posts ?? 0);
  let suppressed = Number(row?.suppressed ?? 0);
  let skippedNote = 0;
  if (now - start >= FAST_WINDOW_MS) {
    skippedNote = suppressed;             // last window's overflow, said once
    start = now; posts = 0; suppressed = 0;
  }
  if (posts >= FAST_CAP) {
    return { post: false, write: { start, posts, suppressed: suppressed + 1 }, skippedNote: 0 };
  }
  return { post: true, write: { start, posts: posts + 1, suppressed }, skippedNote };
}

/** Make (or find) the game's forum post. Returns the thread id, or null
 *  when no forum is configured or Discord refused. */
export async function ensureThread(env, gameId) {
  const row = await feedRow(env, gameId);
  if (row?.thread_id) return row.thread_id;
  const forum = await forumId(env);
  if (!forum || !env.DISCORD_BOT_TOKEN) return null;
  const room = await env.DB.prepare('SELECT name FROM rooms WHERE id = ?').bind(gameId).first();
  const name = String(room?.name ?? gameId).slice(0, 100);
  const origin = (env.PUBLIC_ORIGIN || 'https://orbital-empire.com').replace(/\/+$/, '');
  const res = await botFetch(env, 'POST', `/channels/${forum}/threads`, {
    name,
    auto_archive_duration: 10080,
    message: {
      content: `📡 **${name}**: this game's feed. Follow this post to get its news; `
        + `players can also follow from the game's notification settings.\n${origin}/?room=${encodeURIComponent(gameId)}`,
    },
  });
  if (!res.ok) {
    console.error('feed thread create failed', gameId, res.status, await res.text().catch(() => ''));
    return null;
  }
  const thread = await res.json();
  // Claimed with a guard so two posts racing on the first tick keep ONE
  // thread; the loser's thread is left as an empty post (rare, harmless).
  await env.DB
    .prepare(`UPDATE game_feeds SET thread_id = ?, guild_id = ?, updated_ms = ? WHERE game_id = ? AND thread_id IS NULL`)
    .bind(thread.id, thread.guild_id ?? null, Date.now(), gameId).run();
  const won = (await feedRow(env, gameId))?.thread_id ?? thread.id;
  if (won === thread.id) {
    // One line in the shared channel, which is now for cross-game news:
    // a new game's feed exists, and here is where to follow it.
    try {
      const discord = await import('./discord.js');
      const main = await discord.resolveChannelIdPublic(env);
      if (main) {
        await botFetch(env, 'POST', `/channels/${main}/messages`, {
          content: `📡 **${name}** has a game feed: <#${won}>. Follow it there for that game's news.`,
          allowed_mentions: { parse: [] },
        });
      }
    } catch (e) { console.error('feed pointer post failed', e); }
    const followers = (await env.DB
      .prepare(`SELECT u.discord_id FROM game_feed_followers f JOIN users u ON u.id = f.user_id
                 WHERE f.game_id = ? AND u.discord_id IS NOT NULL`)
      .bind(gameId).all()).results ?? [];
    for (const f of followers) {
      await botFetch(env, 'PUT', `/channels/${won}/thread-members/${f.discord_id}`).catch(() => {});
    }
  }
  return won;
}

/** Post to a thread, reopening it if Discord archived it for inactivity. */
async function postToThread(env, threadId, body) {
  let res = await botFetch(env, 'POST', `/channels/${threadId}/messages`, body);
  if (!res.ok && (res.status === 400 || res.status === 403)) {
    const text = await res.clone().text().catch(() => '');
    if (/archived|50083/.test(text)) {
      await botFetch(env, 'PATCH', `/channels/${threadId}`, { archived: false });
      res = await botFetch(env, 'POST', `/channels/${threadId}/messages`, body);
    }
  }
  return res;
}

/**
 * Where THIS post for THIS game goes: a thread id, or null (feed off, not
 * a headline at 'headlines', over the fast-game cap, no forum). Every
 * room-level publisher asks this, once per post.
 */
export async function feedTarget(env, gameId, { headline = false } = {}) {
  if (!gameId || !env.DISCORD_BOT_TOKEN) return null;
  const row = await feedRow(env, gameId);
  if (!row || !levelAdmits(row.level, headline)) return null;
  const game = await env.DB.prepare('SELECT tick_interval_ms FROM games WHERE id = ?').bind(gameId).first();
  const now = Date.now();
  const d = rateDecision(row, Number(game?.tick_interval_ms ?? 0), now);
  if (d.write) {
    await env.DB
      .prepare('UPDATE game_feeds SET window_start_ms = ?, window_posts = ?, suppressed = ? WHERE game_id = ?')
      .bind(d.write.start, d.write.posts, d.write.suppressed, gameId).run();
  }
  if (!d.post) return null;
  const server = await serverDestination(env, row);
  const threadId = server
    ? (server.kind === 'forum' ? await ensureServerThread(env, gameId, row) : server.channelId)
    : await ensureThread(env, gameId);
  if (threadId && d.skippedNote > 0) {
    await postToThread(env, threadId, {
      content: `⏩ ${d.skippedNote} more update${d.skippedNote === 1 ? '' : 's'} skipped: this game moves fast, so its feed is capped at ${FAST_CAP} posts every ${FAST_WINDOW_MS / 60000} minutes. The Herald covers the rest.`,
    }).catch(() => {});
  }
  return threadId;
}

/** Post a JSON message (or multipart form) to the game's feed. */
export async function postToFeed(env, gameId, body, { headline = false } = {}) {
  const threadId = await feedTarget(env, gameId, { headline });
  if (!threadId) return { posted: false, reason: 'feed_off', res: null, threadId: null };
  const res = await postToThread(env, threadId, body);
  return { posted: res.ok, reason: res.ok ? null : `discord_${res.status}`, res, threadId };
}

// ------------------------------------------------------- YOUR OWN SERVER

/** What the bot asks for when it joins a host's server: read and post in
 *  the feed channel, embeds and the battle-card image, and run a forum
 *  post (create it, post in it, reopen it when Discord archives it). */
export const SERVER_BOT_PERMISSIONS = (
  (1n << 10n)   // View Channel
  | (1n << 11n) // Send Messages
  | (1n << 14n) // Embed Links
  | (1n << 15n) // Attach Files
  | (1n << 16n) // Read Message History
  | (1n << 34n) // Manage Threads (reopen its own archived post)
  | (1n << 35n) // Create Public Threads
  | (1n << 38n) // Send Messages in Threads
).toString();

const DISCORD_AUTHORIZE = 'https://discord.com/oauth2/authorize';
const DISCORD_TOKEN = 'https://discord.com/api/oauth2/token';
const CONNECT_TTL_MS = 10 * 60 * 1000;

function serverRedirectUri(env, url) {
  const origin = env.PUBLIC_ORIGIN || `${url.protocol}//${url.host}`;
  return `${origin.replace(/\/+$/, '')}/api/discord/feed/callback`;
}

/** The host's channel, if one is connected AND its Commission still
 *  stands; null means the Orbital forum. */
export async function serverDestination(env, row) {
  if (!row?.server_channel_id || !row.server_by_user_id) return null;
  if (!(await hasEntitlement(env, row.server_by_user_id))) return null;
  return {
    kind: row.server_channel_kind === 'forum' ? 'forum' : 'text',
    channelId: row.server_channel_id,
    guildId: row.server_guild_id,
  };
}

/** The opening words in a host's server: what this is, whose Commission
 *  pays for it, and the way in -- the game itself, and the free game. */
async function welcomeText(env, gameId, hostName) {
  const room = await env.DB.prepare('SELECT name, invite_code FROM rooms WHERE id = ?').bind(gameId).first();
  const origin = (env.PUBLIC_ORIGIN || 'https://orbital-empire.com').replace(/\/+$/, '');
  const name = String(room?.name ?? 'This game');
  const lines = [
    `📡 **${name}** reports here now: wars, battles, Senate votes and the daily Herald, as they happen.`,
    `Brought to you by ${hostName ?? 'the host'}'s Commander's Commission ❖.`,
    room?.invite_code
      ? `Want in? Join the game: ${origin}/?invite=${encodeURIComponent(room.invite_code)}&from=discord-feed`
      : `Play Orbital free: ${origin}/?from=discord-feed`,
  ];
  return { name, content: lines.join('\n') };
}

/** The game's post in the host's FORUM channel, made once. */
async function ensureServerThread(env, gameId, row) {
  if (row.server_thread_id) return row.server_thread_id;
  const host = await env.DB
    .prepare('SELECT display_name FROM users WHERE id = ?').bind(row.server_by_user_id).first();
  const w = await welcomeText(env, gameId, host?.display_name);
  const res = await botFetch(env, 'POST', `/channels/${row.server_channel_id}/threads`, {
    name: w.name.slice(0, 100),
    auto_archive_duration: 10080,
    message: { content: w.content, allowed_mentions: { parse: [] } },
  });
  if (!res.ok) {
    console.error('server feed thread create failed', gameId, res.status, await res.text().catch(() => ''));
    return null;
  }
  const thread = await res.json();
  await env.DB
    .prepare('UPDATE game_feeds SET server_thread_id = ? WHERE game_id = ? AND server_thread_id IS NULL')
    .bind(thread.id, gameId).run();
  return (await feedRow(env, gameId))?.server_thread_id ?? thread.id;
}

/**
 * GET /api/games/:gameId/feed/connect -- a browser navigation from the
 * host's feed settings. Checks the rules, then hands the host to
 * Discord's consent screen (add the bot + pick the channel).
 */
export async function handleConnectStart(req, env, { session, params, url }) {
  const { gameId } = params;
  if (!GAME_ID_RE.test(gameId)) return page('No such game', 'That link is broken.', false);
  const c = await caller(env, gameId, session);
  if (c.error) return page('Not your game', 'Only a player in this game can change its feed.', false);
  if (!c.isHost) return page('Only the host can do this', "Ask the game's host to connect their server.", false);
  if (!(await hasEntitlement(env, session.user_id))) {
    return page('A Commission feature',
      "Sending a game's feed to your own Discord server comes with the Commander's Commission. "
      + 'You can get it from your profile in Orbital.', false);
  }
  const clientId = await discordClientId(env);
  if (!clientId || !env.DISCORD_CLIENT_SECRET || !env.DISCORD_BOT_TOKEN) {
    return page('Not available yet', "Orbital's Discord bot is not set up on this server yet.", false);
  }
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const now = Date.now();
  await env.DB.prepare('DELETE FROM discord_link_codes WHERE expires_at < ?').bind(now).run();
  await env.DB
    .prepare('INSERT INTO discord_link_codes (code, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(`feed:${gameId}:${nonce}`, session.user_id, now, now + CONNECT_TTL_MS).run();
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope: 'bot applications.commands webhook.incoming',
    permissions: SERVER_BOT_PERMISSIONS,
    redirect_uri: serverRedirectUri(env, url),
    state: `${gameId}.${nonce}`,
  });
  return Response.redirect(`${DISCORD_AUTHORIZE}?${q}`, 302);
}

/** GET /api/discord/feed/callback -- Discord sends the host back here. */
export async function handleConnectCallback(_req, env, { url }) {
  const code = url.searchParams.get('code');
  const state = String(url.searchParams.get('state') ?? '');
  const [gameId, nonce] = state.split('.');
  if (url.searchParams.get('error') || !code || !gameId || !nonce || !GAME_ID_RE.test(gameId)) {
    return page('Nothing was connected', 'You can try again from the game whenever you like.', false);
  }
  // Consume the state ONCE (a replayed callback connects nothing).
  const key = `feed:${gameId}:${nonce}`;
  const st = await env.DB.prepare('SELECT user_id, expires_at FROM discord_link_codes WHERE code = ?').bind(key).first();
  await env.DB.prepare('DELETE FROM discord_link_codes WHERE code = ?').bind(key).run();
  if (!st || st.expires_at < Date.now()) {
    return page('That link expired', 'Head back to the game and press Connect again.', false);
  }
  // Re-check the rules: minutes may have passed on Discord's page.
  const room = await env.DB.prepare('SELECT host_id FROM rooms WHERE id = ?').bind(gameId).first();
  if (!room || room.host_id !== st.user_id || !(await hasEntitlement(env, st.user_id))) {
    return page('Could not connect', "Only the game's host, holding the Commission, can connect a server.", false);
  }

  const tokenRes = await fetch(DISCORD_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: await discordClientId(env),
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: serverRedirectUri(env, url),
    }),
  });
  if (!tokenRes.ok) {
    console.error('feed connect token exchange failed', tokenRes.status, await tokenRes.text().catch(() => ''));
    return page('Discord refused the connection', 'Please try again from the game.', false);
  }
  const tok = await tokenRes.json();
  const hook = tok.webhook;
  if (!hook?.channel_id) {
    return page('No channel was picked', 'Try again, and choose the channel the game should post in.', false);
  }
  // The webhook was only Discord's way of telling us the channel; the bot
  // posts as itself. Remove it so the server's integrations stay tidy.
  if (hook.id && hook.token) {
    await fetch(`${DISCORD_API}/webhooks/${hook.id}/${hook.token}`, { method: 'DELETE' }).catch(() => {});
  }
  const chRes = await botFetch(env, 'GET', `/channels/${hook.channel_id}`);
  if (!chRes.ok) {
    return page('Orbital cannot see that channel',
      'Give the Orbital role permission to view and post in it, then connect again.', false);
  }
  const ch = await chRes.json();
  const kind = ch.type === 15 || ch.type === 16 ? 'forum' : 'text';
  const guildId = hook.guild_id ?? tok.guild?.id ?? ch.guild_id ?? null;
  const guildName = tok.guild?.name ?? null;

  const now = Date.now();
  await env.DB
    .prepare(`INSERT INTO game_feeds (game_id, level, updated_ms) VALUES (?, 'all', ?)
              ON CONFLICT(game_id) DO NOTHING`)
    .bind(gameId, now).run();
  // Connecting says "I want this game in my server": a feed that is off
  // is turned on (everything; it is their own channel). A level the host
  // already chose is kept.
  await env.DB
    .prepare(`UPDATE game_feeds
                 SET server_guild_id = ?, server_guild_name = ?, server_channel_id = ?,
                     server_channel_name = ?, server_channel_kind = ?, server_thread_id = NULL,
                     server_by_user_id = ?, server_connected_ms = ?, updated_ms = ?,
                     level = CASE WHEN level = 'off' THEN 'all' ELSE level END
               WHERE game_id = ?`)
    .bind(guildId, guildName, ch.id, ch.name ?? null, kind, st.user_id, now, now, gameId).run();

  // Say hello where the game will post, which also proves the bot can.
  const host = await env.DB.prepare('SELECT display_name FROM users WHERE id = ?').bind(st.user_id).first();
  let posted = true;
  if (kind === 'forum') {
    posted = !!(await ensureServerThread(env, gameId, await feedRow(env, gameId)));
  } else {
    const w = await welcomeText(env, gameId, host?.display_name);
    const res = await postToThread(env, ch.id, { content: w.content, allowed_mentions: { parse: [] } });
    posted = res.ok;
    if (!res.ok) console.error('server feed welcome failed', gameId, res.status, await res.text().catch(() => ''));
  }
  const where = `#${(ch.name ?? 'your channel').replace(/[<>&]/g, '')}`
    + (guildName ? ` in ${String(guildName).replace(/[<>&]/g, '')}` : '');
  return posted
    ? page('Connected', `This game now posts to ${where}. You can close this tab and head back to Orbital.`)
    : page('Connected, but Orbital cannot post there yet',
      `Give the Orbital role permission to send messages in ${where}; the next update will arrive by itself.`, false);
}

/** DELETE /api/games/:gameId/feed/server -- host only. Back to the Orbital forum. */
export async function handleDisconnectServer(_req, env, { session, params }) {
  const { gameId } = params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'bad game id');
  const c = await caller(env, gameId, session);
  if (c.error) return c.error;
  if (!c.isHost) return err(403, 'not_host', "only the host can change where the game's feed posts");
  await env.DB
    .prepare(`UPDATE game_feeds
                 SET server_guild_id = NULL, server_guild_name = NULL, server_channel_id = NULL,
                     server_channel_name = NULL, server_channel_kind = NULL, server_thread_id = NULL,
                     server_by_user_id = NULL, server_connected_ms = NULL, updated_ms = ?
               WHERE game_id = ?`)
    .bind(Date.now(), gameId).run();
  return json(await feedView(env, gameId, session.user_id, c.isHost));
}

// ---------------------------------------------------------------- API

async function caller(env, gameId, session) {
  const room = await env.DB.prepare('SELECT id, host_id FROM rooms WHERE id = ?').bind(gameId).first();
  if (!room) return { error: err(404, 'not_found', 'no such game') };
  const member = await env.DB
    .prepare('SELECT 1 AS x FROM room_members WHERE room_id = ? AND user_id = ?')
    .bind(gameId, session.user_id).first();
  const player = member ? null : await env.DB
    .prepare('SELECT 1 AS x FROM game_factions WHERE game_id = ? AND user_id = ?')
    .bind(gameId, session.user_id).first();
  if (!member && !player) return { error: err(403, 'not_member', 'not in this game') };
  return { room, isHost: room.host_id === session.user_id };
}

async function feedView(env, gameId, userId, isHost) {
  const row = await feedRow(env, gameId);
  const me = await env.DB.prepare('SELECT discord_id FROM users WHERE id = ?').bind(userId).first();
  const follows = !!(await env.DB
    .prepare('SELECT 1 AS x FROM game_feed_followers WHERE game_id = ? AND user_id = ?')
    .bind(gameId, userId).first());
  const forum = await forumId(env);
  const room = await env.DB
    .prepare('SELECT r.host_id, u.display_name AS host_name FROM rooms r LEFT JOIN users u ON u.id = r.host_id WHERE r.id = ?')
    .bind(gameId).first();
  const iHold = await hasEntitlement(env, userId);
  const hostHolds = room?.host_id === userId ? iHold : await hasEntitlement(env, room?.host_id);
  const server = row?.server_channel_id ? {
    guild_name: row.server_guild_name ?? null,
    channel_name: row.server_channel_name ?? null,
    kind: row.server_channel_kind === 'forum' ? 'forum' : 'text',
    url: row.server_guild_id
      ? `https://discord.com/channels/${row.server_guild_id}/${row.server_thread_id ?? row.server_channel_id}` : null,
    // False when the Commission that carries it is gone: posts fall back
    // to the Orbital forum until the host has it again.
    active: !!(await serverDestination(env, row)),
  } : null;
  return {
    level: row?.level ?? 'off',
    thread_url: row?.thread_id && row?.guild_id
      ? `https://discord.com/channels/${row.guild_id}/${row.thread_id}` : null,
    server,
    host_name: room?.host_name ?? null,
    i_hold_commission: iHold,
    host_holds_commission: hostHolds,
    // The client id comes from the bot token (discordClientId); the
    // secret is the one thing that must be configured by hand.
    server_connect_ready: !!(env.DISCORD_CLIENT_SECRET && env.DISCORD_BOT_TOKEN),
    thread_id: row?.thread_id ?? null,
    following: follows,
    discord_linked: !!me?.discord_id,
    forum_configured: !!forum,
    is_host: isHost,
    // The feed lives on the Orbital server; a player who is not on it yet
    // needs the door before the post means anything.
    discord_invite: FEEDBACK_DISCORD_URL,
  };
}

/** GET /api/games/:gameId/feed */
export async function handleGetFeed(_req, env, { session, params }) {
  const { gameId } = params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'bad game id');
  const c = await caller(env, gameId, session);
  if (c.error) return c.error;
  return json(await feedView(env, gameId, session.user_id, c.isHost));
}

/** PUT /api/games/:gameId/feed  { level } — host only. */
export async function handleSetFeed(req, env, { session, params }) {
  const { gameId } = params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'bad game id');
  const c = await caller(env, gameId, session);
  if (c.error) return c.error;
  if (!c.isHost) return err(403, 'not_host', 'only the host can turn the game feed on or off');
  const body = await readJson(req);
  const level = String(body?.level ?? '');
  if (!FEED_LEVELS.includes(level)) return err(400, 'bad_request', `level must be one of ${FEED_LEVELS.join(', ')}`);
  await env.DB
    .prepare(`INSERT INTO game_feeds (game_id, level, updated_ms) VALUES (?, ?, ?)
              ON CONFLICT(game_id) DO UPDATE SET level = excluded.level, updated_ms = excluded.updated_ms`)
    .bind(gameId, level, Date.now()).run();
  return json(await feedView(env, gameId, session.user_id, c.isHost));
}

/** POST /api/games/:gameId/feed/follow  { follow: boolean } */
export async function handleFollowFeed(req, env, { session, params }) {
  const { gameId } = params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'bad game id');
  const c = await caller(env, gameId, session);
  if (c.error) return c.error;
  const body = await readJson(req);
  const follow = body?.follow !== false;
  const me = await env.DB.prepare('SELECT discord_id FROM users WHERE id = ?').bind(session.user_id).first();
  if (follow && !me?.discord_id) {
    return err(409, 'discord_not_linked', 'link your Discord account first, so the bot knows who to add');
  }
  if (follow) {
    await env.DB
      .prepare('INSERT OR IGNORE INTO game_feed_followers (game_id, user_id, created_ms) VALUES (?, ?, ?)')
      .bind(gameId, session.user_id, Date.now()).run();
  } else {
    await env.DB
      .prepare('DELETE FROM game_feed_followers WHERE game_id = ? AND user_id = ?')
      .bind(gameId, session.user_id).run();
  }
  // Mirror it onto the thread when there is one; when there is not, the
  // thread's creation adds every follower.
  const row = await feedRow(env, gameId);
  if (row?.thread_id && me?.discord_id && env.DISCORD_BOT_TOKEN) {
    const res = await botFetch(env, follow ? 'PUT' : 'DELETE',
      `/channels/${row.thread_id}/thread-members/${me.discord_id}`);
    if (!res.ok && res.status !== 404) {
      console.error('feed follow sync failed', gameId, res.status, await res.text().catch(() => ''));
    }
  }
  return json(await feedView(env, gameId, session.user_id, c.isHost));
}

export const routes = [
  { method: 'GET',  pattern: /^\/api\/games\/(?<gameId>[^/]+)\/feed\/connect$/, auth: 'required', handle: handleConnectStart },
  { method: 'GET',  pattern: '/api/discord/feed/callback', auth: 'none', handle: handleConnectCallback },
  { method: 'DELETE', pattern: /^\/api\/games\/(?<gameId>[^/]+)\/feed\/server$/, auth: 'required', handle: handleDisconnectServer },
  { method: 'GET',  pattern: /^\/api\/games\/(?<gameId>[^/]+)\/feed$/, auth: 'required', handle: handleGetFeed },
  { method: 'PUT',  pattern: /^\/api\/games\/(?<gameId>[^/]+)\/feed$/, auth: 'required', handle: handleSetFeed },
  { method: 'POST', pattern: /^\/api\/games\/(?<gameId>[^/]+)\/feed\/follow$/, auth: 'required', handle: handleFollowFeed },
];
