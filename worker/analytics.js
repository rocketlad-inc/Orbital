// ============================================================================
// analytics.js — admin-only live-ops dashboard endpoints.
//
// Access model: allow-listed account EMAILS, checked server-side on every
// request. There is no is_admin column to flip and no client-side-only
// gate — a non-admin (or attacker who guesses the paths) gets a 404, the
// same response a nonexistent route returns, so the surface doesn't
// advertise itself.
//
// Data sources (all written elsewhere, read-only here):
//   faction_metrics    — per-tick yield snapshots (room.js resolveTick)
//   analytics_events   — one row per mutating player action (index.js)
//   sessions           — created_at / last_seen_at give login frequency
//                        and approximate session length (state.js touch)
// ============================================================================

// Feature modules keep their own response helpers (index.js/lobby.js
// don't export theirs) — same shape as fleets.js.
function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}
function err(status, code, message) {
  return json({ error: { code, message } }, { status });
}

// The allow-list. Deliberately code, not config: adding an admin should
// be a reviewed commit, and there is exactly one intended member.
const ADMIN_EMAILS = new Set([
  'lcfeeser@gmail.com',      // Lorne's play account
  'lorne@bigtickets.com',    // Lorne's work account, in case he ever signs up with it
]);

export function isAdminEmail(email) {
  return ADMIN_EMAILS.has(String(email ?? '').toLowerCase());
}

// 404 (not 403) so probing for the endpoint learns nothing.
function requireAdmin(session) {
  if (!session || !isAdminEmail(session.email)) {
    return err(404, 'not_found', 'no such route');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Feature-usage kinds: normalize a mutating request path to a stable label.
// "/api/games/Jt4AQbYy7M4l/ships/Jt4:s12/orders" -> "ships/orders".
// Exported for index.js, which logs at the dispatch choke point.
// ---------------------------------------------------------------------------
export function eventKindFromPath(method, pathname) {
  const m = pathname.match(/^\/api\/games\/[^/]+\/(.+)$/);
  if (!m) return null;
  const parts = m[1].split('/').filter(seg =>
    // Drop id-looking segments: game-namespaced ids contain ':' (or its
    // %3A encoding); bare row ids are long base64ish tokens. Keep short
    // lowercase words — those are the route nouns/verbs.
    !(seg.includes(':') || seg.includes('%3A') || /^[A-Za-z0-9_-]{12,}$/.test(seg)));
  if (parts.length === 0) return null;
  const kind = parts.join('/');
  return `${method} ${kind}`.slice(0, 80);
}

export async function logEvent(env, { gameId, userId, kind }) {
  if (!kind) return;
  try {
    await env.DB
      .prepare('INSERT INTO analytics_events (game_id, user_id, kind, created_at_ms) VALUES (?, ?, ?, ?)')
      .bind(gameId ?? null, userId ?? null, kind, Date.now())
      .run();
  } catch (e) {
    // Telemetry must never fail a player action.
    console.error('analytics logEvent failed', e);
  }
}

// ---------------------------------------------------------------------------
// GET /api/admin/overview
// The landing view: every non-setup game with engagement vitals, plus a
// global 14-day login/session picture.
// ---------------------------------------------------------------------------
async function handleOverview(req, env, { session }) {
  const gate = requireAdmin(session);
  if (gate) return gate;
  const now = Date.now();
  const d14 = now - 14 * 86_400_000;

  const games = await env.DB
    .prepare(
      `SELECT g.id, r.name, g.status, g.current_tick, g.tick_interval_ms,
              g.next_tick_at, g.victory_type, r.created_at,
              (SELECT COUNT(*) FROM game_factions f
                WHERE f.game_id = g.id AND f.user_id IS NOT NULL AND f.status != 'vacated') AS humans,
              (SELECT COUNT(*) FROM game_factions f
                WHERE f.game_id = g.id AND f.status = 'active') AS factions,
              (SELECT MAX(e.created_at_ms) FROM analytics_events e
                WHERE e.game_id = g.id) AS last_action_ms,
              (SELECT COUNT(*) FROM analytics_events e
                WHERE e.game_id = g.id AND e.created_at_ms > ?) AS actions_14d
         FROM games g JOIN rooms r ON r.id = g.id
        WHERE g.status IN ('active', 'completed')
        ORDER BY (g.status = 'active') DESC, g.next_tick_at DESC
        LIMIT 100`,
    )
    .bind(d14)
    .all();

  // Global engagement: per-user login count (sessions opened), total and
  // average session minutes, and last activity — 14-day window. QA and
  // deploy-check accounts are filtered by their @example.com emails.
  const players = await env.DB
    .prepare(
      `SELECT u.id, u.display_name, u.email,
              COUNT(s.token) AS sessions_14d,
              MAX(COALESCE(s.last_seen_at, s.created_at)) AS last_seen_ms,
              AVG(CASE WHEN s.last_seen_at IS NOT NULL
                       THEN (s.last_seen_at - s.created_at) / 60000.0 END) AS avg_session_min
         FROM users u JOIN sessions s ON s.user_id = u.id
        WHERE s.created_at > ? AND u.email NOT LIKE '%@example.com'
        GROUP BY u.id
        ORDER BY last_seen_ms DESC
        LIMIT 50`,
    )
    .bind(d14)
    .all();

  return json({ now, games: games.results ?? [], players: players.results ?? [] });
}

// ---------------------------------------------------------------------------
// GET /api/admin/games/:gameId/analytics
// Everything about one game: faction standings, yield curves, feature
// usage, and per-player engagement.
// ---------------------------------------------------------------------------
async function handleGameAnalytics(req, env, { session, params }) {
  const gate = requireAdmin(session);
  if (gate) return gate;
  const gameId = params.gameId;
  const now = Date.now();
  const d14 = now - 14 * 86_400_000;

  const game = await env.DB
    .prepare(
      `SELECT g.id, r.name, g.status, g.current_tick, g.tick_interval_ms,
              g.next_tick_at, g.victory_type, g.winner_faction_id, r.created_at
         FROM games g JOIN rooms r ON r.id = g.id WHERE g.id = ?`,
    )
    .bind(gameId)
    .first();
  if (!game) return err(404, 'not_found', 'no such game');

  const factions = await env.DB
    .prepare(
      `SELECT f.id, f.name, f.color, f.status, f.user_id, u.display_name AS player_name,
              f.metal, f.fuel, f.gold, f.science, f.reputation,
              (SELECT COUNT(*) FROM game_ships s
                WHERE s.game_id = f.game_id AND s.owner_faction_id = f.id AND s.hp > 0) AS ships,
              (SELECT COUNT(*) FROM game_settlements st
                WHERE st.game_id = f.game_id AND st.owner_faction_id = f.id) AS settlements,
              (SELECT COUNT(*) FROM faction_techs t
                WHERE t.faction_id = f.id AND t.status = 'completed') AS techs_completed
         FROM game_factions f LEFT JOIN users u ON u.id = f.user_id
        WHERE f.game_id = ?
        ORDER BY f.slot`,
    )
    .bind(gameId)
    .all();

  // Yield curves. Downsample server-side: charts can't use more than a
  // few hundred points, and a long game has tick_count × factions rows.
  // Keep every Nth tick plus ALWAYS the latest tick so "now" is exact.
  const tickCount = Math.max(1, game.current_tick);
  const step = Math.max(1, Math.floor(tickCount / 200));
  const curves = await env.DB
    .prepare(
      `SELECT tick_number, faction_id, metal, fuel, gold, science, ships, settlements
         FROM faction_metrics
        WHERE game_id = ? AND (tick_number % ? = 0 OR tick_number = ?)
        ORDER BY tick_number`,
    )
    .bind(gameId, step, game.current_tick)
    .all();

  const usage = await env.DB
    .prepare(
      `SELECT kind,
              COUNT(*) AS total,
              SUM(created_at_ms > ?) AS last_14d,
              COUNT(DISTINCT user_id) AS distinct_users
         FROM analytics_events
        WHERE game_id = ?
        GROUP BY kind
        ORDER BY total DESC`,
    )
    .bind(d14, gameId)
    .all();

  // Per-player engagement, scoped to this game's humans. Sessions are
  // account-wide (there's no per-game session), so session stats read as
  // "how often does this player open Orbital at all" — the right lens
  // for retention even if they split time across games.
  const engagement = await env.DB
    .prepare(
      `SELECT u.id, u.display_name, f.name AS faction_name, f.color,
              (SELECT COUNT(*) FROM sessions s
                WHERE s.user_id = u.id AND s.created_at > ?) AS sessions_14d,
              (SELECT MAX(COALESCE(s.last_seen_at, s.created_at)) FROM sessions s
                WHERE s.user_id = u.id) AS last_seen_ms,
              (SELECT AVG(CASE WHEN s.last_seen_at IS NOT NULL
                               THEN (s.last_seen_at - s.created_at) / 60000.0 END)
                 FROM sessions s WHERE s.user_id = u.id AND s.created_at > ?) AS avg_session_min,
              (SELECT COUNT(*) FROM analytics_events e
                WHERE e.user_id = u.id AND e.game_id = f.game_id AND e.created_at_ms > ?) AS actions_14d
         FROM game_factions f JOIN users u ON u.id = f.user_id
        WHERE f.game_id = ?
        ORDER BY last_seen_ms DESC`,
    )
    .bind(d14, d14, d14, gameId)
    .all();

  return json({
    now,
    game,
    factions: factions.results ?? [],
    curves: curves.results ?? [],
    usage: usage.results ?? [],
    engagement: engagement.results ?? [],
  });
}

export const routes = [
  { method: 'GET', pattern: '/api/admin/overview', auth: 'required', handle: handleOverview },
  { method: 'GET', pattern: /^\/api\/admin\/games\/(?<gameId>[^/]+)\/analytics$/, auth: 'required', handle: handleGameAnalytics },
];
