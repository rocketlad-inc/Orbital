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
  'spaceboy1243@gmail.com',  // Lorne's play account ("Rocketlad" — the one he's actually signed in as)
  'lcfeeser@gmail.com',      // Lorne's infra account
  'lorne@bigtickets.com',    // Lorne's work account, in case he ever signs up with it
]);

export function isAdminEmail(email) {
  return ADMIN_EMAILS.has(String(email ?? '').toLowerCase());
}

// ---------------------------------------------------------------------------
// QA-account exclusion. Every harness identity lives on one of these
// domains (qa/provision.js, sim runners, deploy checks) - real players
// never do. One predicate, applied to every people-facing query, so a
// new report can't accidentally count robots as engagement.
// ---------------------------------------------------------------------------
const QA_DOMAINS = ['%@example.com', '%@example.test', '%@orbital-test.local'];
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
                WHERE e.game_id = g.id AND e.kind != 'heartbeat') AS last_action_ms,
              (SELECT COUNT(*) FROM analytics_events e
                WHERE e.game_id = g.id AND e.kind != 'heartbeat'
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
        WHERE kind != 'heartbeat'
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
        WHERE game_id = ? AND kind != 'heartbeat'
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
                  AND e.kind != 'heartbeat' AND e.created_at_ms > ?) AS actions_14d
         FROM game_factions f JOIN users u ON u.id = f.user_id
        WHERE f.game_id = ?
        ORDER BY last_seen_ms DESC AND ${NOT_QA_USER}`,
    )
    .bind(d14, d14, d14, d14, gameId)
    .all();

  // --- Tech pace: how fast research completes, per faction. The direct
  // measure of "is science too cheap" (it already ended one game).
  const techRows = await env.DB
    .prepare(
      `SELECT faction_id, tech_id, started_at_tick, completed_at_tick
         FROM faction_techs
        WHERE game_id = ? AND status = 'completed' AND completed_at_tick IS NOT NULL`,
    )
    .bind(gameId)
    .all();
  const techByFaction = new Map();
  for (const t of techRows.results ?? []) {
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
  const combat = {
    losses: losses.results ?? [],
    kills: kills.results ?? [],
    settlements_lost: razed.results ?? [],
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

  return json({
    now,
    game,
    factions: factions.results ?? [],
    curves: curves.results ?? [],
    usage: usage.results ?? [],
    engagement: engagement.results ?? [],
    techPace,
    combat,
    shipClasses,
    senate,
    trade,
    dropoff,
    spend: spendRows.results ?? [],
    timeline: timelineRows.results ?? [],
  });
}

// POST /api/games/:gameId/telemetry {kind} - client-side UI events
// ("opened the fleet menu"), so the dashboard can build funnels the
// server's mutation log can't see. Kind is whitelisted to a slug and
// force-prefixed 'ui/' so a client can never spoof server kinds.
const UI_KIND_RE = /^[a-z0-9][a-z0-9_-]{1,32}$/;
async function handleUiTelemetry(req, env, { session, params }) {
  let body = null;
  try { body = await req.json(); } catch { /* unreadable -> bad_kind below */ }
  const kind = body && body.kind;
  if (typeof kind !== 'string' || !UI_KIND_RE.test(kind)) {
    return err(400, 'bad_kind', 'kind must be a short slug');
  }
  await logEvent(env, {
    gameId: params.gameId,
    userId: session.user_id,
    kind: `ui/${kind}`,
  });
  return new Response(null, { status: 204 });
}

export const routes = [
  { method: 'POST', pattern: /^\/api\/games\/(?<gameId>[^/]+)\/telemetry$/, auth: 'required', handle: handleUiTelemetry },
  { method: 'GET', pattern: '/api/admin/overview', auth: 'required', handle: handleOverview },
  { method: 'GET', pattern: /^\/api\/admin\/games\/(?<gameId>[^/]+)\/analytics$/, auth: 'required', handle: handleGameAnalytics },
];
