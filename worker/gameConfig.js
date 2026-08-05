// ============================================================================
// gameConfig.js — resolve the tunables for a given game.
//
// One function matters: cfg(env, gameId). It returns a complete, flat
// object of every knob in configSchema.js, with the game's overrides
// applied over the shipped defaults.
//
// CACHING. resolveTick reads config from a dozen places and runs a few
// hundred times a second in the simulator. A per-game memo keyed on the
// game id, with a short TTL, turns that into one query per game per tick
// window. The TTL exists rather than a permanent cache because a Worker
// isolate can live for many minutes and a freshly published config should
// reach the next NEW game, not the next cold start.
//
// A game's config is pinned at creation (games.config_id), so this never
// changes underneath a match in flight. The TTL only affects how quickly
// a new game picks up a new publish.
//
// FALLBACK IS ALWAYS SAFE. Missing row, malformed JSON, D1 hiccup — every
// path returns schema defaults, which is the game exactly as it shipped.
// A config system that can hard-fail the tick loop is worse than no
// config system.
// ============================================================================

import { defaults, validateAll } from './configSchema.js';

const TTL_MS = 30_000;
const cache = new Map();   // gameId -> { at, value }

/** The shipped game. Cheap, allocation-only, no I/O. */
export function shippedDefaults() {
  return defaults();
}

/**
 * Full config for a game. Never throws.
 *
 * @param gameId  null/undefined resolves the PUBLISHED config, which is
 *                what a game being created should be stamped with.
 */
export async function cfg(env, gameId) {
  const key = gameId ?? '__published__';
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const base = defaults();
  let overrides = null;

  try {
    const row = gameId
      ? await env.DB
        .prepare(
          `SELECT c.overrides FROM games g
             JOIN game_configs c ON c.id = g.config_id
            WHERE g.id = ?`,
        ).bind(gameId).first()
      : await env.DB
        .prepare(
          `SELECT overrides FROM game_configs
            WHERE status = 'published' ORDER BY published_ms DESC LIMIT 1`,
        ).first();
    if (row?.overrides) overrides = JSON.parse(row.overrides);
  } catch {
    // Defaults are always a correct answer. Losing a config lookup must
    // never cost a player their tick.
  }

  if (overrides && typeof overrides === 'object') {
    // Re-validate on READ as well as write. A row could predate a bounds
    // change, or have been edited straight in D1; either way an
    // out-of-range number should not reach combat maths.
    const { clean } = validateAll(overrides);
    Object.assign(base, clean);
  }

  cache.set(key, { at: Date.now(), value: base });
  return base;
}

/** Drop memoised entries. Called after a publish so the next new game
 *  sees it immediately rather than up to TTL_MS later. */
export function invalidate(gameId = null) {
  if (gameId) cache.delete(gameId);
  else cache.clear();
}

/**
 * The id a NEW game should be stamped with: whatever is published, or
 * null for "shipped defaults". Returning null rather than inventing a row
 * keeps a fresh install working with no config records at all.
 */
export async function publishedConfigId(env) {
  try {
    const row = await env.DB
      .prepare(`SELECT id FROM game_configs WHERE status = 'published'
                 ORDER BY published_ms DESC LIMIT 1`).first();
    return row?.id ?? null;
  } catch {
    return null;
  }
}
