// ============================================================================
// cull.js - end the games and close the lobbies nobody is using.
//
// THE RULE (the owner's): a game with no PLAYER action for 15 days is ended.
// A lobby nobody has touched for 15 days is closed. No email about either,
// ever (emails are expensive), and nothing is deleted.
//
// WHAT "NO ACTION" MEANS. The last action a HUMAN took in the game:
//
//   * analytics_game_seen.last_action_ms (adminDashboard.js rollup): the last
//     mutating request under /api/games/:id/... by a non-robot account.
//     Heartbeats (watching the map) and perf/telemetry chatter are NOT
//     actions. It trails real time by the rollup cadence (a cron minute plus
//     the 2-minute ROLLUP_LAG_MS), which is nothing against 15 days. It has
//     no row for a game that never had an action, and only starts at the
//     rollup's first run (an older game's early actions may be missing): for
//     those the game's own start time stands in, so a game that never had an
//     action is culled 15 days after it STARTED, and a new game never early.
//   * Two raw checks veto a cull the rollup does not know about:
//       - any human analytics_events action newer than the cutoff (the
//         rollup lags, and it leaves out unsaved Play for Free accounts,
//         which are people);
//       - a human who JOINED the game inside the window.
//
// WHO IS HUMAN. Not an agent account (@agents.orbital.local: QA agents AND
// the computer empires of solo games, whose requests are made by calling
// the route handlers directly, so they never reach the analytics log anyway)
// and not a harness account (the other QA domains). Unsaved trial accounts
// (@shadow.orbital.local) ARE people, so they count.
//
// ENDING A GAME (abandonGame) is the normal finish with nobody winning:
// games.status = 'completed', victory_type = 'abandoned', no winner. The tick
// loop reads status and stops; the Room DO is told so its alarm is cancelled
// and connected players are sent game_completed. The finish's side effects
// (email, awards, final Herald, saga) are NOT run: that is the point.
//
// CLOSING A LOBBY (closeLobby): rooms.status = 'closed' - the state Browse,
// Join and the room socket already refuse. My Games still lists it (see
// lobby.js handleMine) as closed for being idle; the cull_log row is how it
// knows the difference from a Studio close.
// ============================================================================

import { QA_DOMAINS } from './analytics.js';
import { tr } from './i18n.js';

export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** No action for this long ends a game; no touch for this long closes a lobby. */
export const CULL_AFTER_MS = 15 * 24 * 3600 * 1000;
/** Most work one run does; the rest waits for the next hour. */
export const MAX_GAMES_PER_RUN = 25;
export const MAX_LOBBIES_PER_RUN = 50;
/** Never culled, whatever the table says (migration 0188 also sets no_cull):
 *  the frozen marketing showcase. */
export const NEVER_CULL_IDS = ['Kai68RfB5BhV', 'ij9VVSf4t5d4'];

/** Accounts whose activity is not a person's: every QA domain except the
 *  unsaved trial accounts, which are real visitors. */
const NOT_HUMAN_DOMAINS = QA_DOMAINS.filter(d => !d.includes('shadow'));
export const humanUser = (col) => NOT_HUMAN_DOMAINS.map(d => `${col} NOT LIKE '${d}'`).join(' AND ');
/** A player action in analytics_events (adminDashboard.js IS_ACTION). */
export const IS_ACTION = `e.kind <> 'heartbeat' AND e.kind NOT LIKE 'POST perf%'`;

const stamp = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : null);

// ---------------------------------------------------------------------------
// Selection (shared by the sweep, the dry run and scripts/cull-dry-run-prod.mjs)
// ---------------------------------------------------------------------------

/**
 * Active games whose last human action is older than the cutoff, oldest
 * first. `opts.noCullColumn === false` is for a database that has not run
 * migration 0188 yet (the read-only prod dry run).
 *
 * The vetoes live in the WHERE so that LIMIT counts only games that really
 * would be culled.
 */
export async function findIdleGames(env, nowMs, opts = {}) {
  const cutoff = nowMs - CULL_AFTER_MS;
  const limit = opts.limit ?? MAX_GAMES_PER_RUN;
  const noCull = opts.noCullColumn === false ? '0' : 'COALESCE(g.no_cull, 0)';
  // Plain `?` placeholders only: scripts/cull-dry-run-prod.mjs inlines the
  // values into read-only SQL and does not understand numbered ones.
  const never = NEVER_CULL_IDS.map(id => `'${id}'`).join(', ');
  // (No SQL comments in these queries: the read-only prod script flattens
  // them onto one line.) raw_ms: the rollup leaves out unsaved trial players,
  // so a TRIAL game's last action is read from its raw events (a few rows).
  const rows = (await env.DB.prepare(
    `SELECT g.id, r.name, g.status, g.current_tick, g.started_at, g.created_at, g.solo, g.trial,
            s.last_action_ms, s.last_beat_ms,
            MAX(COALESCE(s.last_action_ms, 0), COALESCE(g.started_at, g.created_at, 0)) AS rollup_ms,
            CASE WHEN g.trial = 1 THEN (SELECT MAX(e.created_at_ms) FROM analytics_events e JOIN users u ON u.id = e.user_id
              WHERE e.game_id = g.id AND ${IS_ACTION} AND ${humanUser('u.email')}) END AS raw_ms,
            (SELECT COUNT(*) FROM game_factions f JOIN users u ON u.id = f.user_id
              WHERE f.game_id = g.id AND f.ai_doctrine IS NULL AND ${humanUser('u.email')}) AS humans
       FROM games g
       JOIN rooms r ON r.id = g.id
       LEFT JOIN analytics_game_seen s ON s.game_id = g.id
      WHERE g.status = 'active'
        AND ${noCull} = 0
        AND COALESCE(g.is_test_game, 0) = 0
        AND g.id NOT IN (${never})
        AND MAX(COALESCE(s.last_action_ms, 0), COALESCE(g.started_at, g.created_at, 0)) < ?
        AND NOT EXISTS (SELECT 1 FROM analytics_events e JOIN users u ON u.id = e.user_id
                         WHERE e.game_id = g.id AND e.created_at_ms >= ? AND ${IS_ACTION}
                           AND ${humanUser('u.email')})
        AND NOT EXISTS (SELECT 1 FROM game_factions f JOIN users u ON u.id = f.user_id
                         WHERE f.game_id = g.id AND f.joined_at >= ? AND f.ai_doctrine IS NULL
                           AND ${humanUser('u.email')})
      ORDER BY rollup_ms ASC, g.id ASC
      LIMIT ?`,
  ).bind(cutoff, cutoff, cutoff, limit).all()).results ?? [];
  return rows.map(r => {
    const last = Math.max(Number(r.rollup_ms) || 0, Number(r.raw_ms) || 0);
    const hadAction = (Number(r.last_action_ms) || Number(r.raw_ms) || 0) > 0;
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      humans: Number(r.humans) || 0,
      solo: Number(r.solo) === 1,
      trial: Number(r.trial) === 1,
      tick: Number(r.current_tick) || 0,
      startedAt: Number(r.started_at ?? r.created_at) || null,
      lastActivityMs: last,
      lastHumanBeatMs: Number(r.last_beat_ms) || null,
      idleDays: Math.floor((nowMs - last) / DAY_MS),
      reason: hadAction
        ? `no player action since ${stamp(last)}`
        : `no player action since it started (${stamp(last)})`,
    };
  });
}

/**
 * Lobbies (a room with no game yet) untouched for the cutoff. Activity is
 * the latest of the room's updated_at (every join, leave, setting and
 * start attempt touches it), created_at and the newest member's joined_at.
 * Lobby chat lives in the Room DO's memory and does not count.
 */
export async function findIdleLobbies(env, nowMs, opts = {}) {
  const cutoff = nowMs - CULL_AFTER_MS;
  const limit = opts.limit ?? MAX_LOBBIES_PER_RUN;
  const rows = (await env.DB.prepare(
    `SELECT x.* FROM (
       SELECT r.id, r.name, r.host_id, r.max_players, r.quick_join, r.created_at, r.updated_at,
              (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) AS members,
              MAX(COALESCE(r.updated_at, 0), COALESCE(r.created_at, 0),
                  COALESCE((SELECT MAX(m.joined_at) FROM room_members m WHERE m.room_id = r.id), 0)) AS last_ms
         FROM rooms r
        WHERE r.status = 'lobby'
          AND NOT EXISTS (SELECT 1 FROM games g WHERE g.id = r.id)
     ) x
      WHERE x.last_ms < ?
      ORDER BY x.last_ms ASC, x.id ASC
      LIMIT ?`,
  ).bind(cutoff, limit).all()).results ?? [];
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    status: 'lobby',
    humans: Number(r.members) || 0,
    seats: Number(r.max_players) || 0,
    quickJoin: Number(r.quick_join) === 1,
    updatedAt: Number(r.updated_at) || null,
    lastActivityMs: Number(r.last_ms) || 0,
    idleDays: Math.floor((nowMs - Number(r.last_ms)) / DAY_MS),
    reason: `nobody has touched this lobby since ${stamp(Number(r.last_ms))}`,
  }));
}

// ---------------------------------------------------------------------------
// Ending a game / closing a lobby
// ---------------------------------------------------------------------------

function roomStub(env, id) {
  return env.ROOM.get(env.ROOM.idFromName(id));
}

/**
 * End a game for inactivity. Idempotent: a game that is not 'active' (already
 * ended, or never started) is left alone and `{ ended: false }` comes back.
 *
 * opts.cutoffMs: when given, the write itself re-checks that no human acted
 * since (the sweep passes it), so an action that lands between selection and
 * this call saves the game.
 */
export async function abandonGame(env, gameId, opts = {}) {
  const now = opts.nowMs ?? Date.now();
  const cutoff = opts.cutoffMs ?? null;
  const guard = cutoff == null ? '' : `
        AND NOT EXISTS (SELECT 1 FROM analytics_events e JOIN users u ON u.id = e.user_id
                         WHERE e.game_id = games.id AND e.created_at_ms >= ?4 AND ${IS_ACTION}
                           AND ${humanUser('u.email')})`;
  const binds = [now, gameId, 'abandoned'];
  if (cutoff != null) binds.push(cutoff);
  const res = await env.DB.prepare(
    `UPDATE games
        SET status = 'completed', victory_type = ?3, winner_faction_id = NULL,
            completed_at = ?1, next_tick_at = NULL
      WHERE id = ?2 AND status = 'active' AND COALESCE(no_cull, 0) = 0${guard}`,
  ).bind(...binds).run();
  if ((res.meta?.changes ?? 0) === 0) return { ended: false, reason: 'not_active' };

  const game = await env.DB.prepare('SELECT current_tick FROM games WHERE id = ?').bind(gameId).first();
  const tick = Number(game?.current_tick) || 0;
  const reason = opts.reason ?? 'idle';
  try {
    await env.DB.batch([
      // ONE chronicle row, no free text: the log explains itself.
      env.DB.prepare(
        `INSERT INTO chronicle_entries
           (id, game_id, tick_number, kind, actor_faction_id, payload, visibility, created_at_ms)
         VALUES (?, ?, ?, 'game_abandoned', NULL, ?, 'public', ?)`,
      ).bind(crypto.randomUUID(), gameId, tick, JSON.stringify({ reason, days: Math.round(CULL_AFTER_MS / DAY_MS) }), now),
      env.DB.prepare(
        `INSERT OR IGNORE INTO cull_log (id, kind, last_activity_ms, culled_ms, reason)
         VALUES (?, 'game', ?, ?, ?)`,
      ).bind(gameId, opts.lastActivityMs ?? null, now, opts.reasonText ?? reason),
    ]);
  } catch (e) {
    console.error('cull: bookkeeping failed for', gameId, e);
  }

  // The Room DO: cancel its alarm (no tick runs after this) and tell the
  // players in the room. D1 is canonical, so a DO that cannot be reached
  // still stops: the tick reads games.status first thing.
  try {
    await roomStub(env, gameId).fetch('https://room/abandon', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tick }),
    });
  } catch (e) {
    console.error('cull: room did not take the news for', gameId, e);
  }
  await postAbandonedToFeed(env, gameId);
  return { ended: true, tick };
}

/**
 * The one outward effect of ending a game: a short line in its Discord feed,
 * where the host turned the feed on (gameFeed.js is the gate: level, the fast
 * game cap and the forum). Never throws.
 */
async function postAbandonedToFeed(env, gameId) {
  try {
    if (!env.DISCORD_BOT_TOKEN) return;
    const feed = await import('./gameFeed.js');
    const row = await env.DB.prepare('SELECT name FROM rooms WHERE id = ?').bind(gameId).first();
    const L = await feed.feedLocale(env, gameId);
    await feed.postToFeed(env, gameId, {
      content: tr(L, 'feed.abandoned.text', { name: row?.name ?? '' }),
    }, { headline: true });
  } catch (e) {
    console.error('cull: feed post failed for', gameId, e);
  }
}

/**
 * Close a lobby for inactivity. Idempotent. `opts.seenUpdatedAt` makes it a
 * compare-and-swap: a join, leave or setting change since selection moves
 * updated_at and the close is skipped.
 */
export async function closeLobby(env, roomId, opts = {}) {
  const now = opts.nowMs ?? Date.now();
  const cas = opts.seenUpdatedAt == null ? '' : ' AND updated_at = ?3';
  const binds = [now, roomId];
  if (opts.seenUpdatedAt != null) binds.push(opts.seenUpdatedAt);
  const res = await env.DB.prepare(
    `UPDATE rooms SET status = 'closed', updated_at = ?1
      WHERE id = ?2 AND status = 'lobby'${cas}
        AND NOT EXISTS (SELECT 1 FROM games g WHERE g.id = rooms.id)`,
  ).bind(...binds).run();
  if ((res.meta?.changes ?? 0) === 0) return { closed: false, reason: 'not_a_lobby' };
  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO cull_log (id, kind, last_activity_ms, culled_ms, reason)
       VALUES (?, 'lobby', ?, ?, ?)`,
    ).bind(roomId, opts.lastActivityMs ?? null, now, opts.reasonText ?? 'idle').run();
  } catch (e) {
    console.error('cull: bookkeeping failed for lobby', roomId, e);
  }
  try {
    await roomStub(env, roomId).fetch('https://room/close-idle', { method: 'POST' });
  } catch (e) {
    console.error('cull: room did not take the news for lobby', roomId, e);
  }
  return { closed: true };
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

async function cullEnabled(env) {
  try {
    const { getSettings } = await import('./botSettings.js');
    return (await getSettings(env)).cull_enabled !== false;
  } catch { return true; }
}

// The hour slot this isolate has already dealt with: the cron calls every
// minute, and 59 of every 60 calls need not touch D1 at all.
let handledSlot = 0;

/**
 * Hourly sweep, called from the minute cron. Never throws.
 *
 *   opts.dryRun   decide and report, write NOTHING (no claim, no log).
 *   opts.force    ignore the staging skip and the hourly claim (tests, the
 *                 operator); the kill switch still applies unless dryRun.
 *   opts.maxGames / opts.maxLobbies   per-run caps.
 */
export async function sweepIdle(env, nowMs = Date.now(), opts = {}) {
  const maxGames = opts.maxGames ?? MAX_GAMES_PER_RUN;
  const maxLobbies = opts.maxLobbies ?? MAX_LOBBIES_PER_RUN;
  try {
    if (opts.dryRun) {
      const [games, lobbies] = await Promise.all([
        findIdleGames(env, nowMs, { limit: opts.limit ?? 1000, noCullColumn: opts.noCullColumn }),
        findIdleLobbies(env, nowMs, { limit: opts.limit ?? 1000 }),
      ]);
      return { dryRun: true, enabled: await cullEnabled(env), cutoffMs: nowMs - CULL_AFTER_MS, games, lobbies };
    }
    if (!opts.force) {
      if (env.ORBITAL_ENV === 'staging') return { ran: false, reason: 'staging' };
      const slot = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
      if (slot === handledSlot) return { ran: false, reason: 'handled' };
    }
    if (!(await cullEnabled(env))) {
      if (!opts.force) handledSlot = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
      return { ran: false, reason: 'disabled' };
    }
    const slot = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
    if (!opts.force) {
      const claim = await env.DB
        .prepare('INSERT OR IGNORE INTO cull_runs (slot_ms, started_ms) VALUES (?, ?)')
        .bind(slot, nowMs).run();
      handledSlot = slot;
      if ((claim.meta?.changes ?? 0) === 0) return { ran: false, reason: 'claimed' };
    } else {
      await env.DB
        .prepare('INSERT OR REPLACE INTO cull_runs (slot_ms, started_ms) VALUES (?, ?)')
        .bind(slot, nowMs).run();
    }

    const cutoff = nowMs - CULL_AFTER_MS;
    // Everything that qualifies is selected (it is a cheap read), a capped
    // part of it is acted on; the rest is counted and waits for next hour.
    const lobbies = await findIdleLobbies(env, nowMs, { limit: 5000 });
    const games = await findIdleGames(env, nowMs, { limit: 5000 });
    let lobbiesClosed = 0;
    let gamesEnded = 0;
    for (const l of lobbies.slice(0, maxLobbies)) {
      try {
        const r = await closeLobby(env, l.id, {
          nowMs, seenUpdatedAt: l.updatedAt, lastActivityMs: l.lastActivityMs, reasonText: l.reason,
        });
        if (r.closed) lobbiesClosed++;
      } catch (e) { console.error('cull: lobby failed', l.id, e); }
    }
    for (const g of games.slice(0, maxGames)) {
      try {
        const r = await abandonGame(env, g.id, {
          nowMs, cutoffMs: cutoff, lastActivityMs: g.lastActivityMs, reasonText: g.reason,
        });
        if (r.ended) gamesEnded++;
      } catch (e) { console.error('cull: game failed', g.id, e); }
    }
    const result = {
      ran: true, gamesEnded, lobbiesClosed,
      gamesLeft: Math.max(0, games.length - maxGames),
      lobbiesLeft: Math.max(0, lobbies.length - maxLobbies),
    };
    await env.DB.prepare(
      `UPDATE cull_runs SET finished_ms = ?, games_ended = ?, lobbies_closed = ?, games_left = ?, lobbies_left = ?
        WHERE slot_ms = ?`,
    ).bind(Date.now(), gamesEnded, lobbiesClosed, result.gamesLeft, result.lobbiesLeft, slot).run();
    return result;
  } catch (e) {
    console.error('cull sweep failed', e);
    return { ran: false, reason: 'error', error: String(e?.message ?? e) };
  }
}

/** Test hook: forget which hour this isolate handled. */
export function _resetCullSlot() { handledSlot = 0; }

// ---------------------------------------------------------------------------
// Operator routes (index.js, agent key only): GET /api/internal/cull/<which>
// ---------------------------------------------------------------------------

const jsonRes = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json' },
});

export async function handleCullInternal(_req, env, which) {
  const now = Date.now();
  if (which === 'dry-run') {
    const out = await sweepIdle(env, now, { dryRun: true });
    return jsonRes({
      ...out,
      cutoff: stamp(out.cutoffMs),
      games: out.games.map(g => ({ ...g, lastActivity: stamp(g.lastActivityMs) })),
      lobbies: out.lobbies.map(l => ({ ...l, lastActivity: stamp(l.lastActivityMs) })),
    });
  }
  if (which === 'status') {
    const enabled = await cullEnabled(env);
    const runs = (await env.DB.prepare(
      'SELECT * FROM cull_runs ORDER BY slot_ms DESC LIMIT 5',
    ).all()).results ?? [];
    const totals = (await env.DB.prepare(
      'SELECT kind, COUNT(*) AS n, MAX(culled_ms) AS last_ms FROM cull_log GROUP BY kind',
    ).all()).results ?? [];
    return jsonRes({
      enabled, staging: env.ORBITAL_ENV === 'staging', after_days: CULL_AFTER_MS / DAY_MS,
      lastRun: runs[0] ?? null, runs, totals,
    });
  }
  return jsonRes({ error: { code: 'not_found', message: 'not found' } }, 404);
}
