// ============================================================================
// GET /api/users/me/awards — the profile's trophy case: the superlatives the
// signed-in player has earned across their FINISHED games.
//
// The shape is the contract in src/multiplayer/profileAwardsTypes.ts
// (ProfileAwardsPayload). The awards themselves are the end-of-game page's
// (worker/ending.js decides who earned what; computeGameAwards is the one
// function behind both). Each finished game's awards are stored once in
// game_awards (migration 0177) — when someone opens the game's ending page, or
// here, the first time the player's profile asks.
//
// Rules this file keeps:
//   * Own data only. The only identity is the session's; nothing here takes a
//     user id from the request.
//   * Past games are filled in a few at a time: at most BACKFILL_PER_REQUEST
//     games are computed per request, newest first, one after another (each is
//     a full batch of queries). The rest are reported as `pending` and the
//     next request finishes them.
//   * A game is worked out once (game_awards_state). A game that earned nobody
//     anything is not asked about again.
//   * Round trips: 1 (the player's finished games), then <= 3 per game computed
//     (marker check, stats batch, store batch), then 1 (the awards). No loops
//     beyond the bounded backfill.
// ============================================================================

import { recordGameAwards } from './ending.js';

/** Games worked out per request; the rest wait for the next one. */
export const BACKFILL_PER_REQUEST = 4;
/** Awards listed (newest game first); totals still count all of them. */
export const MAX_AWARDS = 60;

function json(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(data), { ...init, headers });
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/**
 * Build the payload for one player. Exported for the sim and for tooling.
 * Never throws for a game that fails to compute: that game just stays pending.
 */
export async function buildProfileAwards(env, userId) {
  // A player's finished games, newest first. An observer's seat is not a game
  // they played. (game_factions is unique on (game_id, user_id).)
  const finished = (await env.DB.prepare(
    `SELECT g.id AS game_id, s.game_id AS stored
       FROM game_factions f
       JOIN games g ON g.id = f.game_id
       JOIN rooms r ON r.id = g.id
       LEFT JOIN game_awards_state s ON s.game_id = g.id
      WHERE f.user_id = ? AND g.status = 'completed'
        -- A game ended for inactivity (worker/cull.js) awards nothing.
        AND COALESCE(g.victory_type, '') <> 'abandoned'
        AND f.status NOT IN ('observer', 'monster')
      ORDER BY g.completed_at DESC, g.id`,
  ).bind(userId).all())?.results ?? [];

  const missing = finished.filter(r => r.stored == null).map(r => r.game_id);
  let pending = missing.length;
  for (const gameId of missing.slice(0, BACKFILL_PER_REQUEST)) {
    try {
      await recordGameAwards(env, gameId);
      pending--;
    } catch (e) {
      console.error('profile awards: could not work out', gameId, e);
    }
  }

  const mine = (await env.DB.prepare(
    `SELECT a.game_id, a.award_id, a.value, a.tied, a.ship_name, a.ship_class, a.captain_name,
            a.empire_name, a.won_game, a.completed_at_ms, r.name AS game_name
       FROM game_awards a
       JOIN rooms r ON r.id = a.game_id
      WHERE a.user_id = ?
      ORDER BY a.completed_at_ms DESC, a.game_id, a.award_id`,
  ).bind(userId).all())?.results ?? [];

  // Totals: per award kind, how often, and the best number (a tie on the best
  // goes to the newer game, which is the first row met in this ordering).
  const byAward = new Map();
  for (const r of mine) {
    const t = byAward.get(r.award_id);
    if (!t) {
      byAward.set(r.award_id, {
        awardId: r.award_id, count: 1, best: num(r.value),
        bestGameId: r.game_id, bestGameName: r.game_name ?? '',
      });
    } else {
      t.count++;
      if (num(r.value) > t.best) {
        t.best = num(r.value);
        t.bestGameId = r.game_id;
        t.bestGameName = r.game_name ?? '';
      }
    }
  }
  const totals = [...byAward.values()]
    .sort((a, b) => (b.count - a.count) || (b.best - a.best) || (a.awardId < b.awardId ? -1 : 1));

  const awards = mine.slice(0, MAX_AWARDS).map(r => ({
    gameId: r.game_id,
    gameName: r.game_name ?? '',
    awardId: r.award_id,
    value: num(r.value),
    tied: num(r.tied) === 1,
    ship: r.ship_name != null
      ? { name: r.ship_name, shipClass: r.ship_class ?? null, captainName: r.captain_name ?? null }
      : null,
    empireName: r.empire_name ?? '',
    wonGame: num(r.won_game) === 1,
    completedAtMs: r.completed_at_ms != null ? num(r.completed_at_ms) : null,
  }));

  return {
    gamesFinished: finished.length,
    gamesWithAwards: new Set(mine.map(r => r.game_id)).size,
    totals,
    awards,
    pending,
  };
}

async function handleMyAwards(_req, env, { session }) {
  if (!session?.user_id) {
    return json({ code: 'unauthenticated', error: { code: 'unauthenticated', message: 'sign in required' } }, { status: 401 });
  }
  const payload = await buildProfileAwards(env, session.user_id);
  return json(payload, { headers: { 'cache-control': 'private, no-store' } });
}

export const routes = [
  { method: 'GET', pattern: '/api/users/me/awards', auth: 'required', handle: handleMyAwards },
];
