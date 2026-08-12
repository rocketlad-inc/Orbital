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

// The allow-list lives in ONE place (admins.js) and is re-exported here
// so existing importers of analytics.isAdminEmail keep working. It used
// to be duplicated in store.js; the failure mode of a duplicated
// allow-list is not a bug but an admin who is removed from one copy and
// retains access through the other.
// Imported (not bare re-exported) because this module also USES it
// below — `export ... from` creates no local binding.
import { isAdminEmail } from './admins.js';
export { isAdminEmail };
import { composeHeraldForTickRange } from './digest.js';

// ---------------------------------------------------------------------------
// QA-account exclusion. Every harness identity lives on one of these
// domains (qa/provision.js, sim runners, deploy checks) - real players
// never do. One predicate, applied to every people-facing query, so a
// new report can't accidentally count robots as engagement.
// ---------------------------------------------------------------------------
const QA_DOMAINS = [
  '%@example.com', '%@example.test', '%@orbital-test.local',
  // Agent players (POST /api/agent/session mints agent+<handle>@this).
  // They were counted as REAL engagement until 2026-08-11 — one handle
  // alone had 102 events sitting in the same league as a live playtester,
  // because this list predates agent access existing at all. A robot in
  // the denominator is worse than no metric: it moves retention, session
  // counts and feature adoption in whichever direction the harness
  // happened to be driving that day.
  '%@agents.orbital.local',
];
// For queries that already join users as `u`.
const NOT_QA_USER = QA_DOMAINS.map(d => `u.email NOT LIKE '${d}'`).join(' AND ');
// For event tables with only a user_id: subselect of QA account ids.
const QA_USER_IDS = `SELECT id FROM users WHERE ${QA_DOMAINS.map(d => `email LIKE '${d}'`).join(' OR ')}`;

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
/**
 * Endpoints that are MACHINE chatter, not player behaviour.
 *
 * `perf` and `perf/session` are the client posting its own frame rate and
 * latency on a timer — one row per minute of play, per client, whether
 * the player touches anything or not. They were the second most common
 * "action" in the entire database (3,424 rows against 993 real builds),
 * so every feature-usage chart, action total and actions-per-session
 * average was mostly measuring the metronome rather than the player.
 *
 * The perf DATA is still collected — it lives in its own perf_samples /
 * perf_heartbeats tables and is genuinely useful for finding whose client
 * runs badly. It just has no business in a table about what people DID.
 *
 * `telemetry` is belt-and-braces: the dispatch chokepoint in index.js
 * already skips that path, so it cannot reach here today. It is listed
 * because it is the same category of mistake — the UI-telemetry endpoint
 * writes its own ui/* rows, so counting the POST as well would book every
 * batch twice, once as itself and once as "a player did something".
 */
const NON_ACTION_PATHS = /^perf(\/|$)|^telemetry$/;

export function eventKindFromPath(method, pathname) {
  const m = pathname.match(/^\/api\/games\/[^/]+\/(.+)$/);
  if (!m) return null;
  // Bail before the id-stripping below so this reads against the raw
  // suffix ("perf/session"), not the normalized label.
  if (NON_ACTION_PATHS.test(m[1])) return null;
  const parts = m[1].split('/').filter(seg =>
    // Drop id-looking segments: game-namespaced ids contain ':' (or its
    // %3A encoding); bare row ids are long base64ish tokens. Keep short
    // lowercase words — those are the route nouns/verbs.
    !(seg.includes(':') || seg.includes('%3A') || /^[A-Za-z0-9_-]{12,}$/.test(seg)));
  if (parts.length === 0) return null;
  const kind = parts.join('/');
  return `${method} ${kind}`.slice(0, 80);
}

/** Cap on a stored payload. Telemetry rows outnumber game rows by an
 *  order of magnitude, so an unbounded JSON blob per event is how an
 *  analytics table quietly becomes the biggest thing in the database. */
const PAYLOAD_MAX = 512;

/**
 * Structural payload only — NEVER free text a person wrote.
 *
 * Message bodies, empire names, bill titles and chat all pass through
 * this worker, and any of them would be trivial to attach "for context".
 * A telemetry table that accumulates what players typed to each other is
 * a liability that no engagement metric justifies, so the allowlist is
 * enumerated rather than filtered: only keys named here survive, and
 * every value is coerced to a number, boolean, or short slug.
 */
const PAYLOAD_KEYS = new Set([
  'kind', 'tech', 'level', 'ship_class', 'building', 'body_type',
  'metal', 'gold', 'science', 'count', 'target_kind', 'route_kind',
  'settlement_type', 'stance', 'result', 'screen', 'from', 'ms',
  // Session context. `viewport` is what finally answers "how much of this
  // game is actually played on a phone" — the question the whole mobile
  // effort has been guessing at. `tz_offset` is minutes from UTC, kept
  // because server timestamps are UTC and "do they play in the evening"
  // is a local-time question; coarse enough to be a timezone, not a
  // location.
  'viewport', 'tz_offset', 'is_touch',
]);

function sanitizePayload(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!PAYLOAD_KEYS.has(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(v);
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,40}$/.test(v)) out[k] = v;
    // anything else (objects, arrays, prose, long strings) is dropped
  }
  const keys = Object.keys(out);
  if (keys.length === 0) return null;
  const s = JSON.stringify(out);
  return s.length > PAYLOAD_MAX ? null : s;
}

/** Client-generated visit id. Opaque to us, so validate the shape rather
 *  than trust it — it is a grouping key, never an authorization one. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{6,40}$/;

export async function logEvent(env, { gameId, userId, kind, payload, sessionId, dwellMs }) {
  if (!kind) return;
  try {
    const dwell = Number.isFinite(Number(dwellMs))
      // Clamp to 6h: a backgrounded tab that reports a three-day dwell
      // would drag every average it touches.
      ? Math.max(0, Math.min(6 * 3600 * 1000, Math.round(Number(dwellMs))))
      : null;
    await env.DB
      .prepare(
        `INSERT INTO analytics_events
           (game_id, user_id, kind, payload, session_id, dwell_ms, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        gameId ?? null, userId ?? null, kind,
        sanitizePayload(payload),
        (typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId)) ? sessionId : null,
        dwell,
        Date.now(),
      )
      .run();
  } catch (e) {
    // Telemetry must never fail a player action.
    console.error('analytics logEvent failed', e);
  }
}

// Spend-by-category: called at each debiting action site alongside the
// debit batch. Best-effort like logEvent - a lost row must never fail
// the player's action.
export async function logSpend(env, { gameId, factionId, category, metal = 0, gold = 0 }) {
  if (!category || (!metal && !gold)) return;
  try {
    await env.DB
      .prepare('INSERT INTO spend_events (game_id, faction_id, category, metal, gold, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(gameId ?? null, factionId ?? null, category, Math.round(metal), Math.round(gold), Date.now())
      .run();
  } catch (e) {
    console.error('analytics logSpend failed', e);
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
  const d7 = now - 7 * 86_400_000;

  const games = await env.DB
    .prepare(
      `SELECT g.id, r.name, g.status, g.current_tick, g.tick_interval_ms,
              g.next_tick_at, g.victory_type, r.created_at,
              (SELECT COUNT(*) FROM game_factions f
                WHERE f.game_id = g.id AND f.user_id IS NOT NULL AND f.status != 'vacated') AS humans,
              (SELECT COUNT(*) FROM game_factions f
                WHERE f.game_id = g.id AND f.status = 'active') AS factions,
              (SELECT MAX(e.created_at_ms) FROM analytics_events e
                WHERE e.game_id = g.id AND e.kind != 'heartbeat' AND e.kind NOT LIKE 'POST perf%') AS last_action_ms,
              (SELECT COUNT(*) FROM analytics_events e
                WHERE e.game_id = g.id AND e.kind != 'heartbeat' AND e.kind NOT LIKE 'POST perf%'
                  AND e.created_at_ms > ?) AS actions_14d,
              (SELECT MAX(e.created_at_ms) FROM analytics_events e
                WHERE e.game_id = g.id AND e.kind = 'heartbeat') AS last_heartbeat_ms,
              (SELECT MAX(c.created_at_ms) FROM chronicle_entries c
                WHERE c.game_id = g.id AND c.kind = 'ship_destroyed') AS last_combat_ms,
              (SELECT MAX(sp.proposed_at_tick) FROM senate_proposals sp
                WHERE sp.game_id = g.id) AS last_proposal_tick
         FROM games g JOIN rooms r ON r.id = g.id
        WHERE g.status IN ('active', 'completed')
          AND EXISTS (SELECT 1 FROM game_factions f JOIN users u ON u.id = f.user_id
                       WHERE f.game_id = g.id AND ${NOT_QA_USER})
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
              (SELECT COUNT(*) FROM analytics_events e
                WHERE e.user_id = u.id AND e.kind = 'heartbeat'
                  AND e.created_at_ms > ?) AS minutes_14d,
              (SELECT COUNT(*) FROM analytics_events e
                WHERE e.user_id = u.id AND e.kind = 'heartbeat'
                  AND e.created_at_ms > ?) AS minutes_7d,
              (SELECT COUNT(*) FROM analytics_events e
                WHERE e.user_id = u.id AND e.kind = 'heartbeat'
                  AND e.created_at_ms > ? AND e.created_at_ms <= ?) AS minutes_prior7,
              (SELECT COUNT(DISTINCT date(e.created_at_ms / 1000, 'unixepoch'))
                 FROM analytics_events e
                WHERE e.user_id = u.id AND e.kind = 'heartbeat'
                  AND e.created_at_ms > ?) AS active_days_14d
         FROM users u JOIN sessions s ON s.user_id = u.id
        WHERE s.created_at > ? AND ${NOT_QA_USER}
        GROUP BY u.id
        ORDER BY last_seen_ms DESC
        LIMIT 50`,
    )
    .bind(d14, d7, d14, d7, d14, d14)
    .all();

  // Retention: users created in the last 28 days, with their latest
  // activity. D1/D7/D14 = "had a heartbeat on or after created + N
  // days". Computed in JS - the cohort is tiny.
  const d28 = now - 28 * 86_400_000;
  const cohortRows = await env.DB
    .prepare(
      `SELECT u.id, u.display_name, u.created_at,
              (SELECT MAX(e.created_at_ms) FROM analytics_events e
                WHERE e.user_id = u.id AND e.kind = 'heartbeat') AS last_hb
         FROM users u
        WHERE u.created_at > ? AND ${NOT_QA_USER}`,
    )
    .bind(d28)
    .all();
  const DAY = 86_400_000;
  const retention = (cohortRows.results ?? []).map(u => ({
    id: u.id,
    display_name: u.display_name,
    created_at: u.created_at,
    d1: u.last_hb != null && u.last_hb >= u.created_at + DAY,
    d7: u.last_hb != null && u.last_hb >= u.created_at + 7 * DAY,
    d14: u.last_hb != null && u.last_hb >= u.created_at + 14 * DAY,
  }));

  // Play-hour heatmap: heartbeats by UTC hour over the last 14 days.
  // The client relabels to the viewer's timezone.
  const heat = await env.DB
    .prepare(
      `SELECT CAST(strftime('%w', created_at_ms / 1000, 'unixepoch') AS INTEGER) AS dow,
              CAST(strftime('%H', created_at_ms / 1000, 'unixepoch') AS INTEGER) AS hour,
              COUNT(*) AS n
         FROM analytics_events
        WHERE kind = 'heartbeat' AND created_at_ms > ?
          AND user_id NOT IN (${QA_USER_IDS})
        GROUP BY dow, hour`,
    )
    .bind(d14)
    .all();
  // 7x24 grid, UTC; the client shifts to the viewer's local clock.
  const heatGrid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const r of heat.results ?? []) heatGrid[r.dow][r.hour] = r.n;

  // Sparkline series for each ACTIVE game's card: total gold across all
  // factions at the last 30 recorded ticks. One tiny query per active
  // game - the list is short (LIMIT guards the pathological case).
  const sparks = {};
  const activeGames = (games.results ?? []).filter(g => g.status === 'active').slice(0, 20);
  for (const g of activeGames) {
    try {
      const rows = await env.DB
        .prepare(
          `SELECT tick_number, SUM(gold) AS v FROM faction_metrics
            WHERE game_id = ? GROUP BY tick_number
            ORDER BY tick_number DESC LIMIT 30`,
        )
        .bind(g.id)
        .all();
      sparks[g.id] = (rows.results ?? []).reverse().map(r => [r.tick_number, r.v]);
    } catch (e) { console.error('spark query failed', e); }
  }

  // Cross-game meta: which features are used ANYWHERE. The client
  // compares this against the feature registry to list what is unused
  // everywhere (cut/rework candidates).
  const usageGlobal = await env.DB
    .prepare(
      `SELECT kind, COUNT(*) AS total, COUNT(DISTINCT game_id) AS games_used
         FROM analytics_events
        WHERE kind != 'heartbeat' AND kind NOT LIKE 'POST perf%'
          AND (user_id IS NULL OR user_id NOT IN (${QA_USER_IDS}))
        GROUP BY kind ORDER BY total DESC LIMIT 60`,
    )
    .all();

  return json({
    now,
    games: games.results ?? [],
    players: players.results ?? [],
    retention,
    heat_grid: heatGrid,
    sparks,
    usage_global: usageGlobal.results ?? [],
  });
}

// ---------------------------------------------------------------------------
// GET /api/admin/games/:gameId/analytics
// Everything about one game: faction standings, yield curves, feature
// usage, and per-player engagement.
// ---------------------------------------------------------------------------
/**
 * Admin Herald preview: render an edition for an arbitrary tick range
 * of any game, read-only. Built to check the 2026-08 prose-depth pass
 * against real chronicle data before trusting it — composeHeraldForGame
 * anchors to wall-clock "now", which finds nothing in a game that
 * ended months ago; this filters on tick_number instead so a finished
 * match's full history is previewable in slices.
 *
 * GET /api/admin/games/:gameId/herald-preview?from=<tick>&to=<tick>
 */
async function handleHeraldPreview(req, env, { session, params, url }) {
  const gate = requireAdmin(session);
  if (gate) return gate;
  const gameId = params.gameId;
  const game = await env.DB
    .prepare('SELECT id, current_tick FROM games WHERE id = ?')
    .bind(gameId)
    .first();
  if (!game) return err(404, 'not_found', 'no such game');
  const room = await env.DB.prepare('SELECT name FROM rooms WHERE id = ?').bind(gameId).first();

  const fromTick = Number(url.searchParams.get('from'));
  const toTick = Number(url.searchParams.get('to'));
  if (!Number.isFinite(fromTick) || !Number.isFinite(toTick) || toTick <= fromTick) {
    return err(400, 'bad_request', 'from/to must be numeric ticks with to > from');
  }

  const edition = await composeHeraldForTickRange(
    env, { id: game.id, name: room?.name ?? game.id }, fromTick, toTick,
  );
  return json({ edition });
}

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
              CAST(ROUND(f.metal) AS INTEGER) AS metal,
              CAST(ROUND(f.fuel) AS INTEGER) AS fuel,
              CAST(ROUND(f.gold) AS INTEGER) AS gold,
              CAST(ROUND(f.science) AS INTEGER) AS science,
              f.reputation,
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
      `SELECT tick_number, faction_id,
              CAST(ROUND(metal) AS INTEGER) AS metal,
              CAST(ROUND(fuel) AS INTEGER) AS fuel,
              CAST(ROUND(gold) AS INTEGER) AS gold,
              CAST(ROUND(science) AS INTEGER) AS science,
              ships, settlements
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
        WHERE game_id = ? AND kind != 'heartbeat' AND kind NOT LIKE 'POST perf%'
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
      `SELECT u.id, u.display_name, f.id AS faction_id, f.name AS faction_name, f.color,
              (SELECT COUNT(*) FROM sessions s
                WHERE s.user_id = u.id AND s.created_at > ?) AS sessions_14d,
              (SELECT MAX(COALESCE(s.last_seen_at, s.created_at)) FROM sessions s
                WHERE s.user_id = u.id) AS last_seen_ms,
              (SELECT COUNT(*) FROM analytics_events e
                WHERE e.user_id = u.id AND e.game_id = f.game_id
                  AND e.kind = 'heartbeat' AND e.created_at_ms > ?) AS minutes_14d,
              (SELECT COUNT(DISTINCT date(e.created_at_ms / 1000, 'unixepoch'))
                 FROM analytics_events e
                WHERE e.user_id = u.id AND e.game_id = f.game_id
                  AND e.kind = 'heartbeat' AND e.created_at_ms > ?) AS active_days_14d,
              (SELECT COUNT(*) FROM analytics_events e
                WHERE e.user_id = u.id AND e.game_id = f.game_id
                  AND e.kind != 'heartbeat' AND e.kind NOT LIKE 'POST perf%' AND e.created_at_ms > ?) AS actions_14d
         FROM game_factions f JOIN users u ON u.id = f.user_id
        WHERE f.game_id = ? AND ${NOT_QA_USER}
        ORDER BY last_seen_ms DESC`,
    )
    .bind(d14, d14, d14, d14, gameId)
    .all();

  // --- Tech pace: how fast research completes, per faction. The direct
  // measure of "is science too cheap" (it already ended one game).
  // Raw rows, level included: one row per (faction, track), where level
  // is how far up the 15*(n^1.72) cost curve that faction has climbed.
  // The client computes cost-weighted throughput from this - raw
  // ticks-per-tech made an early-quitter with three cheap level-1s look
  // "15x faster" than players grinding level-8s.
  const techRows = await env.DB
    .prepare(
      `SELECT faction_id, tech_id, level, status, started_at_tick, completed_at_tick
         FROM faction_techs
        WHERE game_id = ?`,
    )
    .bind(gameId)
    .all();
  const techDetail = (techRows.results ?? []).filter(t => (t.level ?? 0) > 0 || t.status === 'completed');
  const techByFaction = new Map();
  for (const t of (techRows.results ?? []).filter(r => r.status === 'completed' && r.completed_at_tick != null)) {
    let agg = techByFaction.get(t.faction_id);
    if (!agg) { agg = { completed: 0, total_ticks: 0, last_tick: 0 }; techByFaction.set(t.faction_id, agg); }
    agg.completed += 1;
    agg.total_ticks += Math.max(0, (t.completed_at_tick ?? 0) - (t.started_at_tick ?? 0));
    if (t.completed_at_tick > agg.last_tick) agg.last_tick = t.completed_at_tick;
  }
  const techPace = [...techByFaction.entries()].map(([faction_id, agg]) => ({
    faction_id,
    completed: agg.completed,
    avg_ticks: agg.completed ? Math.round(agg.total_ticks / agg.completed) : 0,
    last_completed_tick: agg.last_tick,
  }));

  // --- Combat ledger: losses by owner, kills by attacker (from the
  // ship_destroyed payload's killer attribution), settlements razed.
  const losses = await env.DB
    .prepare(
      `SELECT actor_faction_id AS faction_id, COUNT(*) AS n
         FROM chronicle_entries
        WHERE game_id = ? AND kind = 'ship_destroyed'
        GROUP BY actor_faction_id`,
    )
    .bind(gameId)
    .all();
  const kills = await env.DB
    .prepare(
      `SELECT json_extract(payload, '$.killer_faction_id') AS faction_id, COUNT(*) AS n
         FROM chronicle_entries
        WHERE game_id = ? AND kind = 'ship_destroyed'
          AND json_extract(payload, '$.killer_faction_id') IS NOT NULL
        GROUP BY 1`,
    )
    .bind(gameId)
    .all();
  const razed = await env.DB
    .prepare(
      `SELECT actor_faction_id AS faction_id, COUNT(*) AS n
         FROM chronicle_entries
        WHERE game_id = ? AND kind = 'settlement_destroyed'
        GROUP BY actor_faction_id`,
    )
    .bind(gameId)
    .all();
  // COMBAT V2 telemetry (migration 0063). The exchange, not just the
  // outcome: volleys, hits, damage and kills per attacker-class ->
  // target-class pairing. This is what makes the model checkable against a
  // real game — the predicted hit matrix is a claim, and this is the
  // evidence. Tolerates a missing table so an un-migrated isolate degrades
  // to "no data" rather than 500ing the whole analytics page.
  let tally = [];
  try {
    const t = await env.DB
      .prepare(
        `SELECT attacker_class, target_class, volleys, hits, damage, kills,
                damage_raw, damage_absorbed, overkill
           FROM game_combat_tally WHERE game_id = ?`,
      )
      .bind(gameId)
      .all();
    tally = t.results ?? [];
  } catch (e) {
    console.error('combat tally read failed (table may not exist yet)', e);
  }

  // ---- Second-wave combat analytics (migration 0069) -------------------
  // Every block below is independently wrapped, so one missing table
  // degrades a single panel instead of the whole page.

  /** Per-hull records — the only source that can NAME a ship, so it
   *  powers both the MVP awards and the loadout analysis. */
  let shipStats = [];
  try {
    const r = await env.DB
      .prepare(
        `SELECT ss.ship_id, ss.ship_name, ss.ship_class, ss.faction_id,
                ss.shots, ss.hits, ss.shots_taken, ss.hits_taken,
                ss.damage_dealt, ss.damage_taken, ss.damage_absorbed,
                ss.kills, ss.overkill, ss.low_hp_kills,
                CASE WHEN s.id IS NULL OR s.status <> 'active' THEN 0 ELSE 1 END AS alive
           FROM game_ship_stats ss
           LEFT JOIN game_ships s ON s.id = ss.ship_id
          WHERE ss.game_id = ?`,
      )
      .bind(gameId)
      .all();
    shipStats = r.results ?? [];
  } catch (e) {
    console.error('ship stats read failed (table may not exist yet)', e);
  }

  /** Repair vs destruction — is the fleet healing faster than it dies? */
  const economy = { hp_repaired: 0, hp_destroyed: 0 };
  try {
    const r = await env.DB
      .prepare('SELECT stat, value FROM game_combat_stats WHERE game_id = ?')
      .bind(gameId)
      .all();
    for (const row of r.results ?? []) economy[row.stat] = row.value;
  } catch (e) {
    console.error('combat stats read failed (table may not exist yet)', e);
  }

  /** Captain survival. The rescue roll is the whole retention story now
   *  that veterancy is captain-only — a lost ace is unrecoverable. */
  let captains = { lost: 0, rescued: 0, active: 0, banked: 0, top_rank: 0, avg_rank: 0 };
  try {
    const c = await env.DB
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM chronicle_entries
             WHERE game_id = ?1 AND kind = 'captain_lost')     AS lost,
           (SELECT COUNT(*) FROM chronicle_entries
             WHERE game_id = ?1 AND kind = 'captain_rescued')  AS rescued,
           (SELECT COUNT(*) FROM game_captains
             WHERE game_id = ?1 AND status = 'active')         AS active,
           (SELECT COUNT(*) FROM game_captains
             WHERE game_id = ?1 AND status = 'active' AND ship_id IS NULL) AS banked,
           (SELECT COALESCE(MAX(rank), 0) FROM game_captains
             WHERE game_id = ?1 AND status = 'active')         AS top_rank,
           (SELECT COALESCE(AVG(rank), 0) FROM game_captains
             WHERE game_id = ?1 AND status = 'active')         AS avg_rank`,
      )
      .bind(gameId)
      .first();
    if (c) captains = c;
  } catch (e) {
    console.error('captain analytics read failed', e);
  }

  /** Auto-retreat: how often it fires, and whether it actually saves the
   *  hull. A retreat followed by death means the threshold was set too
   *  late to matter. */
  let retreats = { fired: 0, saved: 0 };
  try {
    const r = await env.DB
      .prepare(
        `SELECT COUNT(*) AS fired,
                SUM(CASE WHEN s.status = 'active' THEN 1 ELSE 0 END) AS saved
           FROM chronicle_entries ce
           LEFT JOIN game_ships s ON s.id = ce.ship_id
          WHERE ce.game_id = ? AND ce.kind = 'ship_retreated'`,
      )
      .bind(gameId)
      .first();
    if (r) retreats = { fired: r.fired ?? 0, saved: r.saved ?? 0 };
  } catch (e) {
    console.error('retreat analytics read failed', e);
  }

  /** Detonators: a hull spent for damage. Worth it, or a trap? */
  let detonations = { count: 0, damage: 0, kills: 0 };
  try {
    const d = await env.DB
      .prepare(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(CAST(json_extract(payload,'$.damage') AS REAL)), 0) AS damage,
                COALESCE(SUM(CAST(json_extract(payload,'$.destroyed') AS INTEGER)), 0) AS kills
           FROM chronicle_entries
          WHERE game_id = ? AND kind = 'ship_detonated'`,
      )
      .bind(gameId)
      .first();
    if (d) detonations = d;
  } catch (e) {
    console.error('detonation analytics read failed', e);
  }

  /** Target-priority adoption — does anyone actually override AUTO? */
  let priority = { armed: 0, custom: 0 };
  try {
    const p = await env.DB
      .prepare(
        `SELECT COUNT(*) AS armed,
                SUM(CASE WHEN target_priority IS NOT NULL THEN 1 ELSE 0 END) AS custom
           FROM game_ships
          WHERE game_id = ? AND status = 'active' AND damage_per_tick > 0`,
      )
      .bind(gameId)
      .first();
    if (p) priority = { armed: p.armed ?? 0, custom: p.custom ?? 0 };
  } catch (e) {
    console.error('priority adoption read failed', e);
  }

  /** Battles: cluster combat events by BODY, grouping ticks that are
   *  close together into one engagement. Answers "how long does a fight
   *  actually last" — the live check on the pacing the whole combat model
   *  was tuned around. */
  let battles = { count: 0, avg_ticks: 0, longest: 0, avg_deaths: 0, decisive: 0 };
  try {
    const rows = (await env.DB
      .prepare(
        `SELECT body_id, tick_number, kind
           FROM chronicle_entries
          WHERE game_id = ? AND kind IN ('ship_damaged','ship_destroyed','settlement_destroyed')
            AND body_id IS NOT NULL
          ORDER BY body_id, tick_number`,
      )
      .bind(gameId)
      .all()).results ?? [];
    // A lull longer than this ends the engagement. Combat fires EVERY
    // tick while hostiles share an orbit, so a longer gap means somebody
    // left or died.
    const BATTLE_GAP = 3;
    const byBody = new Map();
    for (const r of rows) {
      if (!byBody.has(r.body_id)) byBody.set(r.body_id, []);
      byBody.get(r.body_id).push(r);
    }
    const lengths = [];
    const deaths = [];
    let decisive = 0;
    for (const evs of byBody.values()) {
      let start = null;
      let last = null;
      let dead = 0;
      const close = () => {
        if (start === null) return;
        lengths.push(last - start + 1);
        deaths.push(dead);
        if (dead > 0) decisive++;
        start = null;
        dead = 0;
      };
      for (const e of evs) {
        if (start === null) start = e.tick_number;
        else if (e.tick_number - last > BATTLE_GAP) { close(); start = e.tick_number; }
        last = e.tick_number;
        if (e.kind !== 'ship_damaged') dead++;
      }
      close();
    }
    if (lengths.length > 0) {
      battles = {
        count: lengths.length,
        avg_ticks: lengths.reduce((a, b) => a + b, 0) / lengths.length,
        longest: Math.max(...lengths),
        avg_deaths: deaths.reduce((a, b) => a + b, 0) / deaths.length,
        decisive,
      };
    }
  } catch (e) {
    console.error('battle clustering failed', e);
  }

  /** Loadout effectiveness. Deaths carry the hull's parts (added with
   *  0069), so we can ask which fits actually die, read against what is
   *  still flying. Pre-0069 rows carry no parts and are SKIPPED rather
   *  than counted as bare hulls, which would flatter the empty loadout. */
  let loadouts = [];
  try {
    const norm = (parts) => {
      const counts = {};
      for (const part of parts ?? []) counts[part] = (counts[part] ?? 0) + 1;
      const keys = Object.keys(counts).sort();
      return keys.length === 0 ? 'bare hull' : keys.map(k => k + ' x' + counts[k]).join(' + ');
    };
    const agg = new Map();
    const bump = (cls, key, field) => {
      const k = cls + '|' + key;
      let e = agg.get(k);
      if (!e) { e = { ship_class: cls, loadout: key, alive: 0, lost: 0 }; agg.set(k, e); }
      e[field]++;
    };
    const aliveRows = (await env.DB
      .prepare(
        `SELECT ship_class, parts_json FROM game_ships
          WHERE game_id = ? AND status = 'active'`,
      )
      .bind(gameId).all()).results ?? [];
    for (const r of aliveRows) {
      let parts = [];
      try { parts = JSON.parse(r.parts_json || '[]'); } catch { parts = []; }
      bump(r.ship_class, norm(parts), 'alive');
    }
    const deadRows = (await env.DB
      .prepare(
        `SELECT json_extract(payload,'$.ship_class') AS ship_class,
                json_extract(payload,'$.parts')      AS parts
           FROM chronicle_entries
          WHERE game_id = ? AND kind = 'ship_destroyed'`,
      )
      .bind(gameId).all()).results ?? [];
    for (const r of deadRows) {
      if (r.parts === null || r.parts === undefined) continue;   // pre-0069 row
      let parts = [];
      try { parts = JSON.parse(r.parts) ?? []; } catch { continue; }
      bump(r.ship_class ?? 'unknown', norm(parts), 'lost');
    }
    loadouts = [...agg.values()]
      .sort((a, b) => (b.alive + b.lost) - (a.alive + a.lost))
      .slice(0, 24);
  } catch (e) {
    console.error('loadout analytics failed', e);
  }

  const combat = {
    losses: losses.results ?? [],
    kills: kills.results ?? [],
    settlements_lost: razed.results ?? [],
    tally,
    ship_stats: shipStats,
    economy,
    captains,
    retreats,
    detonations,
    priority,
    battles,
    loadouts,
  };

  // --- Ship class popularity: what people build (alive) and what dies
  // (lost, from the destruction payload).
  const classesAlive = await env.DB
    .prepare(
      `SELECT ship_class, COUNT(*) AS n FROM game_ships
        WHERE game_id = ? AND hp > 0 GROUP BY ship_class ORDER BY n DESC`,
    )
    .bind(gameId)
    .all();
  const classesLost = await env.DB
    .prepare(
      `SELECT json_extract(payload, '$.ship_class') AS ship_class, COUNT(*) AS n
         FROM chronicle_entries
        WHERE game_id = ? AND kind = 'ship_destroyed'
        GROUP BY 1 ORDER BY n DESC`,
    )
    .bind(gameId)
    .all();
  const shipClasses = { alive: classesAlive.results ?? [], lost: classesLost.results ?? [] };

  // --- Senate participation: proposals raised per faction + vote
  // behaviour. No-shows are derivable client-side (proposal_total minus
  // a faction's total votes).
  const proposals = await env.DB
    .prepare(
      `SELECT COALESCE(proposer_faction_id, 'system') AS faction_id, COUNT(*) AS n
         FROM senate_proposals WHERE game_id = ? GROUP BY 1`,
    )
    .bind(gameId)
    .all();
  const votes = await env.DB
    .prepare(
      `SELECT v.faction_id, v.vote, COUNT(*) AS n
         FROM senate_votes v JOIN senate_proposals p ON p.id = v.proposal_id
        WHERE p.game_id = ? GROUP BY v.faction_id, v.vote`,
    )
    .bind(gameId)
    .all();
  const proposalTotal = (proposals.results ?? []).reduce((acc, r) => acc + r.n, 0);
  const senate = {
    proposals: proposals.results ?? [],
    votes: votes.results ?? [],
    proposal_total: proposalTotal,
  };

  // --- Trade & diplomacy volume.
  const routes = await env.DB
    .prepare(
      `SELECT owner_faction_id AS faction_id, COUNT(*) AS n
         FROM game_trade_routes WHERE game_id = ? GROUP BY 1`,
    )
    .bind(gameId)
    .all();
  const offers = await env.DB
    .prepare(
      `SELECT status, COUNT(*) AS n FROM trade_offers WHERE game_id = ? GROUP BY status`,
    )
    .bind(gameId)
    .all();
  const trade = { routes: routes.results ?? [], offers: offers.results ?? [] };

  // --- Session drop-off: the last real action players take before going
  // idle (>30 min without even a heartbeat). A repeated pattern here is
  // a frustration-point flag. JS pass over recent events, newest 4000.
  const evRows = await env.DB
    .prepare(
      `SELECT user_id, kind, created_at_ms FROM analytics_events
        WHERE game_id = ? AND user_id IS NOT NULL
        ORDER BY created_at_ms DESC LIMIT 4000`,
    )
    .bind(gameId)
    .all();
  const byUser = new Map();
  for (const e of (evRows.results ?? []).reverse()) {
    let arr = byUser.get(e.user_id);
    if (!arr) { arr = []; byUser.set(e.user_id, arr); }
    arr.push(e);
  }
  const GAP = 30 * 60_000;
  const dropoffCounts = new Map();
  byUser.forEach(arr => {
    let lastAction = null;
    for (let i = 0; i < arr.length; i++) {
      const e = arr[i];
      const prev = arr[i - 1];
      if (prev && e.created_at_ms - prev.created_at_ms > GAP && lastAction) {
        dropoffCounts.set(lastAction, (dropoffCounts.get(lastAction) ?? 0) + 1);
      }
      if (e.kind !== 'heartbeat') lastAction = e.kind;
    }
    // Tail: a player who is idle RIGHT NOW ended a session too.
    const last = arr[arr.length - 1];
    if (last && now - last.created_at_ms > GAP && lastAction) {
      dropoffCounts.set(lastAction, (dropoffCounts.get(lastAction) ?? 0) + 1);
    }
  });
  const dropoff = [...dropoffCounts.entries()]
    .map(([kind, n]) => ({ kind, n }))
    .sort((x, y) => y.n - x.n)
    .slice(0, 12);

  // --- Spend by category (0053): where the resources actually go.
  const spendRows = await env.DB
    .prepare(
      `SELECT faction_id, category, SUM(metal) AS metal, SUM(gold) AS gold
         FROM spend_events WHERE game_id = ?
        GROUP BY faction_id, category`,
    )
    .bind(gameId)
    .all();

  // --- Per-player daily activity timeline: minutes per day, last 14d.
  const timelineRows = await env.DB
    .prepare(
      `SELECT user_id, date(created_at_ms / 1000, 'unixepoch') AS day, COUNT(*) AS n
         FROM analytics_events
        WHERE game_id = ? AND kind = 'heartbeat' AND created_at_ms > ?
          AND user_id NOT IN (${QA_USER_IDS})
        GROUP BY user_id, day`,
    )
    .bind(gameId, d14)
    .all();

  // --- Client performance: per-player percentiles over the last 7 days.
  // Median tells the typical feel; p95 is the stall the player remembers
  // and complains about, which an average would hide entirely.
  const perfRows = await env.DB
    .prepare(
      `SELECT p.user_id, u.display_name, p.total_ms, p.action_ms, p.fetch_ms,
              p.map_ms, p.paint_ms, p.frame_ms, p.ships, p.cores, p.mem_gb,
              p.mobile, p.ua
         FROM perf_samples p JOIN users u ON u.id = p.user_id
        WHERE p.game_id = ? AND p.created_at_ms > ? AND ${NOT_QA_USER}
        ORDER BY p.created_at_ms DESC
        LIMIT 4000`,
    )
    .bind(gameId, now - 7 * 86_400_000)
    .all();
  const perfByUser = new Map();
  for (const r of perfRows.results ?? []) {
    let e = perfByUser.get(r.user_id);
    if (!e) {
      e = {
        user_id: r.user_id, display_name: r.display_name,
        n: 0, totals: [], maps: [], paints: [], fetches: [], frames: [],
        ships: r.ships, cores: r.cores, mem_gb: r.mem_gb,
        mobile: r.mobile, ua: r.ua,
      };
      perfByUser.set(r.user_id, e);
    }
    e.n++;
    e.totals.push(r.total_ms); e.maps.push(r.map_ms);
    e.paints.push(r.paint_ms); e.fetches.push(r.fetch_ms);
    e.frames.push(r.frame_ms);
  }
  const pct = (arr, q) => {
    if (arr.length === 0) return 0;
    const a = [...arr].sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor(a.length * q))];
  };
  const perf = [...perfByUser.values()].map(e => ({
    user_id: e.user_id, display_name: e.display_name, samples: e.n,
    total_p50: pct(e.totals, 0.5), total_p95: pct(e.totals, 0.95),
    map_p50: pct(e.maps, 0.5), map_p95: pct(e.maps, 0.95),
    paint_p50: pct(e.paints, 0.5), paint_p95: pct(e.paints, 0.95),
    fetch_p50: pct(e.fetches, 0.5),
    frame_p50: pct(e.frames, 0.5),
    ships: e.ships, cores: e.cores, mem_gb: e.mem_gb,
    mobile: e.mobile, ua: e.ua,
  })).sort((x, y) => y.total_p95 - x.total_p95);

  // --- Render vitals + session degradation. Grouped per player, and
  // within a player per SESSION, so we can compare the first minutes of
  // a session against the last: a flat line means "this machine is
  // simply slow", a downward slope means we are leaking.
  const hbRows = await env.DB
    .prepare(
      `SELECT user_id, session_id, session_ms, fps_avg, fps_low1, frame_p95,
              long_frames, draw_p50, draw_p95, heap_mb, ships, gpu, cores,
              mem_gb, dpr, screen_w, screen_h, mobile, ua
         FROM perf_heartbeats
        WHERE game_id = ? AND created_at_ms > ?
          AND user_id NOT IN (${QA_USER_IDS})
        ORDER BY created_at_ms DESC
        LIMIT 5000`,
    )
    .bind(gameId, now - 7 * 86_400_000)
    .all();
  const nameById = new Map();
  for (const e of engagement.results ?? []) nameById.set(e.id, e.display_name);
  const hbByUser = new Map();
  for (const r of hbRows.results ?? []) {
    let e = hbByUser.get(r.user_id);
    if (!e) {
      e = {
        user_id: r.user_id,
        display_name: nameById.get(r.user_id) ?? 'Unknown',
        beats: 0, fps: [], low1: [], draws: [], longFrames: 0,
        early: [], late: [], heapEarly: [], heapLate: [],
        gpu: r.gpu, cores: r.cores, mem_gb: r.mem_gb, dpr: r.dpr,
        screen: r.screen_w && r.screen_h ? `${r.screen_w}x${r.screen_h}` : null,
        mobile: r.mobile, ua: r.ua, ships: r.ships,
      };
      hbByUser.set(r.user_id, e);
    }
    e.beats++;
    e.fps.push(r.fps_avg);
    e.low1.push(r.fps_low1);
    e.draws.push(r.draw_p95);
    e.longFrames += r.long_frames;
    // First 5 minutes vs 15+ minutes into a session.
    if (r.session_ms < 300_000) { e.early.push(r.fps_avg); if (r.heap_mb) e.heapEarly.push(r.heap_mb); }
    if (r.session_ms > 900_000) { e.late.push(r.fps_avg); if (r.heap_mb) e.heapLate.push(r.heap_mb); }
  }
  const mean = arr => (arr.length ? Math.round(arr.reduce((x, y) => x + y, 0) / arr.length) : 0);
  const render = [...hbByUser.values()].map(e => ({
    user_id: e.user_id, display_name: e.display_name, beats: e.beats,
    fps_avg: mean(e.fps),
    fps_low1: mean(e.low1),
    draw_p95: mean(e.draws),
    long_frames: e.longFrames,
    fps_early: mean(e.early),
    fps_late: mean(e.late),
    heap_early: mean(e.heapEarly),
    heap_late: mean(e.heapLate),
    ships: e.ships,
    gpu: e.gpu, cores: e.cores, mem_gb: e.mem_gb, dpr: e.dpr,
    screen: e.screen, mobile: e.mobile, ua: e.ua,
  })).sort((x, y) => x.fps_avg - y.fps_avg);

  return json({
    now,
    game,
    perf,
    render,
    factions: factions.results ?? [],
    curves: curves.results ?? [],
    usage: usage.results ?? [],
    engagement: engagement.results ?? [],
    techPace,
    techDetail,
    combat,
    shipClasses,
    senate,
    trade,
    dropoff,
    spend: spendRows.results ?? [],
    timeline: timelineRows.results ?? [],
  });
}

// POST /api/games/:gameId/telemetry
//   { kind, session_id?, dwell_ms?, payload?, batch?: [...] }
//
// Client-side UI events, so the dashboard can see what the server's
// mutation log cannot: which screens were opened, how long they were
// read, and in what order inside one visit. Kind is whitelisted to a
// slug and force-prefixed 'ui/' so a client can never spoof a server
// kind like 'POST bodies/build' and forge its own action history.
//
// Accepts a BATCH because screen-dwell events fire on every close: one
// request per menu tap would triple this game's request volume for
// telemetry alone. The client buffers and flushes, so the common case is
// one request carrying several rows.
const UI_KIND_RE = /^[a-z0-9][a-z0-9_-]{1,32}$/;
const BATCH_MAX = 25;

async function handleUiTelemetry(req, env, { session, params }) {
  let body = null;
  try { body = await req.json(); } catch { /* unreadable -> bad_kind below */ }
  if (!body || typeof body !== 'object') {
    return err(400, 'bad_kind', 'kind must be a short slug');
  }

  const items = Array.isArray(body.batch) ? body.batch.slice(0, BATCH_MAX) : [body];
  let accepted = 0;
  for (const it of items) {
    const kind = it && it.kind;
    if (typeof kind !== 'string' || !UI_KIND_RE.test(kind)) continue;
    await logEvent(env, {
      gameId: params.gameId,
      userId: session.user_id,
      kind: `ui/${kind}`,
      payload: it.payload,
      sessionId: it.session_id ?? body.session_id,
      dwellMs: it.dwell_ms,
    });
    accepted += 1;
  }
  // A batch of entirely malformed kinds is a client bug worth surfacing;
  // a batch that was partly good is not worth failing over.
  if (accepted === 0) return err(400, 'bad_kind', 'kind must be a short slug');
  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// POST /api/games/:gameId/perf
// Client latency sample. Not admin-gated - every player reports their own
// numbers; that is the entire point (the slow client is the one we cannot
// reach). Fire-and-forget: a bad or malicious body is clamped and stored,
// never trusted for anything but diagnostics, and never fails the caller.
// ---------------------------------------------------------------------------
async function handlePerfSample(req, env, { session, params }) {
  if (!session) return err(401, 'unauthorized', 'sign in');
  let b;
  try { b = await req.json(); } catch { return json({ ok: true }); }
  // Clamp every number: these come from an untrusted client and only ever
  // feed percentile math, so garbage must degrade to a harmless value
  // rather than skewing an aggregate into nonsense.
  const n = (v, max = 600_000) => {
    const x = Math.round(Number(v));
    return Number.isFinite(x) ? Math.max(0, Math.min(max, x)) : 0;
  };
  try {
    await env.DB
      .prepare(
        `INSERT INTO perf_samples
           (game_id, user_id, total_ms, action_ms, fetch_ms, map_ms, paint_ms,
            frame_ms, ships, cores, mem_gb, mobile, ua, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        params.gameId ?? null, session.user_id,
        n(b.total), n(b.action), n(b.fetch), n(b.map), n(b.paint),
        n(b.frame, 10_000), n(b.ships, 100_000),
        b.cores == null ? null : n(b.cores, 256),
        b.mem == null ? null : n(b.mem, 1024),
        b.mobile ? 1 : 0,
        String(b.ua ?? '').slice(0, 180),
        Date.now(),
      )
      .run();
  } catch (e) {
    console.error('perf sample insert failed', e);
  }
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// POST /api/games/:gameId/perf/session
// One row per minute of active play per client: frame-rate distribution,
// draw cost, heap, scene size, device/GPU. Same trust model as
// /perf — untrusted numbers, clamped, diagnostics only.
// ---------------------------------------------------------------------------
async function handlePerfHeartbeat(req, env, { session, params }) {
  if (!session) return err(401, 'unauthorized', 'sign in');
  let b;
  try { b = await req.json(); } catch { return json({ ok: true }); }
  const n = (v, max = 600_000) => {
    const x = Math.round(Number(v));
    return Number.isFinite(x) ? Math.max(0, Math.min(max, x)) : 0;
  };
  const nOrNull = (v, max) => (v == null ? null : n(v, max));
  const f = (v, max) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.max(0, Math.min(max, x)) : null;
  };
  try {
    await env.DB
      .prepare(
        `INSERT INTO perf_heartbeats
           (game_id, user_id, session_id, session_ms, fps_avg, fps_low1,
            frame_p50, frame_p95, long_frames, frames_seen, draw_p50, draw_p95,
            heap_mb, heap_limit_mb, ships, settlements, in_transit, zoom,
            gpu, cores, mem_gb, dpr, screen_w, screen_h, mobile, ua, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        params.gameId ?? null, session.user_id,
        String(b.session_id ?? '').slice(0, 24) || 'unknown',
        n(b.session_ms, 86_400_000),
        n(b.fps_avg, 1000), n(b.fps_low1, 1000),
        n(b.frame_p50, 60_000), n(b.frame_p95, 60_000),
        n(b.long_frames, 1_000_000), n(b.frames_seen, 1_000_000),
        n(b.draw_p50, 60_000), n(b.draw_p95, 60_000),
        nOrNull(b.heap_mb, 1_000_000), nOrNull(b.heap_limit_mb, 1_000_000),
        n(b.ships, 100_000), n(b.settlements, 100_000), n(b.in_transit, 100_000),
        f(b.zoom, 10_000),
        String(b.gpu ?? '').slice(0, 120) || null,
        nOrNull(b.cores, 256), nOrNull(b.mem_gb, 1024),
        f(b.dpr, 16), nOrNull(b.screen_w, 100_000), nOrNull(b.screen_h, 100_000),
        b.mobile ? 1 : 0, String(b.ua ?? '').slice(0, 180),
        Date.now(),
      )
      .run();
  } catch (e) {
    console.error('perf heartbeat insert failed', e);
  }
  return json({ ok: true });
}

export const routes = [
  { method: 'POST', pattern: /^\/api\/games\/(?<gameId>[^/]+)\/perf\/session$/, auth: 'required', handle: handlePerfHeartbeat },
  { method: 'POST', pattern: /^\/api\/games\/(?<gameId>[^/]+)\/perf$/, auth: 'required', handle: handlePerfSample },
  { method: 'POST', pattern: /^\/api\/games\/(?<gameId>[^/]+)\/telemetry$/, auth: 'required', handle: handleUiTelemetry },
  { method: 'GET', pattern: '/api/admin/overview', auth: 'required', handle: handleOverview },
  { method: 'GET', pattern: /^\/api\/admin\/games\/(?<gameId>[^/]+)\/analytics$/, auth: 'required', handle: handleGameAnalytics },
  { method: 'GET', pattern: /^\/api\/admin\/games\/(?<gameId>[^/]+)\/herald-preview$/, auth: 'required', handle: handleHeraldPreview },
];
