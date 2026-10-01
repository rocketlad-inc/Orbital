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
// ============================================================================

import { json, err, readJson } from './trades.js';
import { FEEDBACK_DISCORD_URL } from './links.js';

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
    .prepare('SELECT game_id, level, thread_id, guild_id, window_start_ms, window_posts, suppressed FROM game_feeds WHERE game_id = ?')
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
  const threadId = await ensureThread(env, gameId);
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
  return {
    level: row?.level ?? 'off',
    thread_url: row?.thread_id && row?.guild_id
      ? `https://discord.com/channels/${row.guild_id}/${row.thread_id}` : null,
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
  { method: 'GET',  pattern: /^\/api\/games\/(?<gameId>[^/]+)\/feed$/, auth: 'required', handle: handleGetFeed },
  { method: 'PUT',  pattern: /^\/api\/games\/(?<gameId>[^/]+)\/feed$/, auth: 'required', handle: handleSetFeed },
  { method: 'POST', pattern: /^\/api\/games\/(?<gameId>[^/]+)\/feed\/follow$/, auth: 'required', handle: handleFollowFeed },
];
