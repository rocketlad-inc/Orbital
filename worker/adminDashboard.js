// ============================================================================
// adminDashboard.js — the admin overview, built to stay cheap at thousands
// of players and games.
//
// The overview used to count straight out of analytics_events on every
// load: 632,550 rows read per load on 2026-09-28 with 163 accounts, most
// of it re-counting heartbeats from July. That table gains a row per
// player per minute, so the cost grew with players TIMES history and the
// page was on course to hit D1's per-query limits long before "thousands".
//
// Now each event is read ONCE. rollupAnalytics (minute cron) folds the
// newest slice into small rollup tables (migration 0150) and advances a
// watermark; every read here touches only the rollups, plus a five-minute
// slice of raw events for "online now". The long lists — games and
// players — are paged and searched on the server, with honest totals,
// instead of shipping the first 50 and silently dropping the rest.
//
// Numbers from the rollups trail real time by the cron lag (a few
// minutes). The payload says how far behind it is, so the page can say so
// rather than pass stale numbers off as live.
// ============================================================================

import { isAdminEmail } from './admins.js';
import { QA_DOMAINS } from './analytics.js';

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}
function err(status, code, message) {
  return json({ error: { code, message } }, { status });
}
// 404 (not 403), same as analytics.js: probing learns nothing.
function requireAdmin(session) {
  if (!session || !isAdminEmail(session.email)) return err(404, 'not_found', 'no such route');
  return null;
}

export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * DAY_MS;
/** 1970-01-01 was a Thursday; the first Monday is four days later. Weeks
 *  in the cohort table start on Monday, UTC. */
const MONDAY_MS = 4 * DAY_MS;

const floorDay = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;

/** email NOT a robot/test account, for a users alias's email column. */
const notQa = (col) => QA_DOMAINS.map(d => `${col} NOT LIKE '${d}'`).join(' AND ');
/** 1 when the email IS a robot/test account (NULL for a missing user). */
const isQa = (col) => `(${QA_DOMAINS.map(d => `${col} LIKE '${d}'`).join(' OR ')})`;
/** Same definition of "a player did something" the old overview used:
 *  anything but the per-minute heartbeat and the client's perf chatter. */
const IS_ACTION = `e.kind != 'heartbeat' AND e.kind NOT LIKE 'POST perf%'`;

// ---------------------------------------------------------------------------
// Rollup
// ---------------------------------------------------------------------------

/** Events newer than this are left for the next pass. Inserts from
 *  different isolates can commit a moment out of timestamp order, and a
 *  row stamped behind the watermark would never be counted. */
export const ROLLUP_LAG_MS = 2 * 60_000;
/** Most history one pass folds in. Only matters while catching up — the
 *  first run after deploy, or after an outage — and keeps any one pass
 *  far below D1's statement limits. */
const ROLLUP_MAX_SPAN_MS = DAY_MS;
/** Passes per cron minute while behind. 70 days of history drains in
 *  about a quarter of an hour; once caught up, one short pass a minute. */
const ROLLUP_MAX_PASSES = 5;

/**
 * Fold every event in [through_ms, now - lag) into the rollup tables.
 *
 * Exactly-once without locks: each insert only runs while the watermark
 * still holds the value this pass read (the EXISTS guard), and the
 * watermark moves in the SAME batch, last. D1 runs batches one at a time
 * and all-or-nothing, so two overlapping cron runs cannot both count a
 * slice — the second one's guard finds the watermark already moved and
 * inserts nothing. Re-runnable from zero: clear the rollup tables, set
 * through_ms = 0, and it rebuilds from the first event.
 */
export async function rollupAnalytics(env, now = Date.now()) {
  let passes = 0;
  let through = null;
  while (passes < ROLLUP_MAX_PASSES) {
    const r = await rollupPass(env, now);
    passes++;
    through = r.through;
    if (!r.advanced || r.caughtUp) break;
  }
  return { passes, through };
}

async function rollupPass(env, now) {
  const state = await env.DB
    .prepare('SELECT through_ms FROM analytics_rollup_state WHERE id = 1')
    .first();
  if (!state) return { advanced: false, through: null };
  const stored = Number(state.through_ms) || 0;
  const horizon = now - ROLLUP_LAG_MS;

  let from = stored;
  if (from === 0) {
    // First run: start at the first event's midnight rather than walking
    // a day at a time from 1970.
    const first = await env.DB.prepare('SELECT MIN(created_at_ms) AS m FROM analytics_events').first();
    from = first?.m != null ? floorDay(Number(first.m)) : horizon;
  }
  const to = Math.min(horizon, from + ROLLUP_MAX_SPAN_MS);
  if (to <= from) return { advanced: false, through: stored, caughtUp: true };

  const guard = 'EXISTS (SELECT 1 FROM analytics_rollup_state WHERE id = 1 AND through_ms = ?3)';
  const range = 'e.created_at_ms >= ?1 AND e.created_at_ms < ?2';
  const day = `CAST(e.created_at_ms / ${DAY_MS} AS INTEGER) * ${DAY_MS}`;
  // MAX() of two values is NULL if either is; the rollups keep NULL for
  // "never", so compare through 0 and map 0 back to NULL.
  const later = (col) => `NULLIF(MAX(COALESCE(${col}, 0), COALESCE(excluded.${col}, 0)), 0)`;

  const stmts = [
    `INSERT INTO analytics_user_day
       (day_ms, user_id, game_id, minutes, actions, last_beat_ms, last_action_ms, qa)
     SELECT ${day}, e.user_id, COALESCE(e.game_id, ''),
            SUM(e.kind = 'heartbeat'),
            SUM(${IS_ACTION}),
            MAX(CASE WHEN e.kind = 'heartbeat' THEN e.created_at_ms END),
            MAX(CASE WHEN ${IS_ACTION} THEN e.created_at_ms END),
            COALESCE(MAX(${isQa('u.email')}), 0)
       FROM analytics_events e LEFT JOIN users u ON u.id = e.user_id
      WHERE ${range} AND e.user_id IS NOT NULL AND ${guard}
      GROUP BY 1, 2, 3
     ON CONFLICT (day_ms, user_id, game_id) DO UPDATE SET
       minutes = minutes + excluded.minutes,
       actions = actions + excluded.actions,
       last_beat_ms = ${later('last_beat_ms')},
       last_action_ms = ${later('last_action_ms')}`,

    `INSERT INTO analytics_heat (hour_ms, minutes)
     SELECT CAST(e.created_at_ms / ${HOUR_MS} AS INTEGER) * ${HOUR_MS}, COUNT(*)
       FROM analytics_events e JOIN users u ON u.id = e.user_id
      WHERE ${range} AND e.kind = 'heartbeat' AND ${notQa('u.email')} AND ${guard}
      GROUP BY 1
     ON CONFLICT (hour_ms) DO UPDATE SET minutes = minutes + excluded.minutes`,

    // Events with no user (rare, system-side) count, as they always did.
    `INSERT INTO analytics_kind_day (day_ms, kind, n)
     SELECT ${day}, e.kind, COUNT(*)
       FROM analytics_events e LEFT JOIN users u ON u.id = e.user_id
      WHERE ${range} AND ${IS_ACTION}
        AND COALESCE(${isQa('u.email')}, 0) = 0 AND ${guard}
      GROUP BY 1, 2
     ON CONFLICT (day_ms, kind) DO UPDATE SET n = n + excluded.n`,

    `INSERT INTO analytics_user_seen (user_id, first_beat_ms, last_beat_ms, minutes)
     SELECT e.user_id, MIN(e.created_at_ms), MAX(e.created_at_ms), COUNT(*)
       FROM analytics_events e
      WHERE ${range} AND e.kind = 'heartbeat' AND e.user_id IS NOT NULL AND ${guard}
      GROUP BY e.user_id
     ON CONFLICT (user_id) DO UPDATE SET
       first_beat_ms = MIN(COALESCE(first_beat_ms, excluded.first_beat_ms), excluded.first_beat_ms),
       last_beat_ms = ${later('last_beat_ms')},
       minutes = minutes + excluded.minutes`,

    // Real players only: a probe game full of agents is not "alive".
    `INSERT INTO analytics_game_seen (game_id, last_beat_ms, last_action_ms)
     SELECT e.game_id,
            MAX(CASE WHEN e.kind = 'heartbeat' THEN e.created_at_ms END),
            MAX(CASE WHEN ${IS_ACTION} THEN e.created_at_ms END)
       FROM analytics_events e JOIN users u ON u.id = e.user_id
      WHERE ${range} AND e.game_id IS NOT NULL AND ${notQa('u.email')} AND ${guard}
      GROUP BY e.game_id
     ON CONFLICT (game_id) DO UPDATE SET
       last_beat_ms = ${later('last_beat_ms')},
       last_action_ms = ${later('last_action_ms')}`,

    // LAST, so every insert above saw the old watermark.
    'UPDATE analytics_rollup_state SET through_ms = ?2 WHERE id = 1 AND through_ms = ?3',
  ];
  await env.DB.batch(stmts.map(sql => env.DB.prepare(sql).bind(from, to, stored)));
  return { advanced: true, through: to, caughtUp: to >= horizon };
}

// ---------------------------------------------------------------------------
// GET /api/admin/overview — the headline numbers, trends and tables that
// stay small no matter how many players there are. Games and players are
// their own paged endpoints below.
// ---------------------------------------------------------------------------
async function handleOverview(req, env, { session }) {
  const gate = requireAdmin(session);
  if (gate) return gate;
  const now = Date.now();
  const today = floorDay(now);
  // "This week" is the last seven COMPLETE days, compared with the seven
  // before. Counting today's partial day against a full prior week would
  // show a drop every morning that is only the clock.
  const w0 = today - 7 * DAY_MS;
  const p0 = today - 14 * DAY_MS;
  const m0 = today - 28 * DAY_MS;
  const series0 = today - 29 * DAY_MS; // 30 days including today
  const heat0 = now - 14 * DAY_MS;
  const usage0 = today - 30 * DAY_MS;
  const usagePrev0 = today - 60 * DAY_MS;
  const cohort0 = floorWeek(now) - 11 * WEEK_MS; // 12 weeks including this one
  const DB = env.DB;

  const q = (sql, ...args) => DB.prepare(sql).bind(...args).all().then(r => r.results ?? []);
  const one = (sql, ...args) => DB.prepare(sql).bind(...args).first();

  const [
    state, players, series, signups, online, games, commission,
    heat, usage, cohorts, sources,
  ] = await Promise.all([
    one('SELECT through_ms FROM analytics_rollup_state WHERE id = 1'),

    one(
      `SELECT COUNT(DISTINCT CASE WHEN day_ms = ?1 THEN user_id END) AS today,
              COUNT(DISTINCT CASE WHEN day_ms >= ?2 AND day_ms < ?1 THEN user_id END) AS week,
              COUNT(DISTINCT CASE WHEN day_ms >= ?3 AND day_ms < ?2 THEN user_id END) AS prev_week,
              COUNT(DISTINCT CASE WHEN day_ms < ?1 THEN user_id END) AS month,
              COALESCE(SUM(CASE WHEN day_ms = ?1 THEN minutes END), 0) AS minutes_today,
              COALESCE(SUM(CASE WHEN day_ms >= ?2 AND day_ms < ?1 THEN minutes END), 0) AS minutes_week,
              COALESCE(SUM(CASE WHEN day_ms >= ?3 AND day_ms < ?2 THEN minutes END), 0) AS minutes_prev_week
         FROM analytics_user_day
        WHERE day_ms >= ?4 AND qa = 0`,
      today, w0, p0, m0),

    q(`SELECT day_ms, COUNT(DISTINCT user_id) AS players,
              SUM(minutes) AS minutes, SUM(actions) AS actions
         FROM analytics_user_day
        WHERE day_ms >= ?1 AND qa = 0
        GROUP BY day_ms ORDER BY day_ms`,
      series0),

    q(`SELECT CAST(u.created_at / ${DAY_MS} AS INTEGER) * ${DAY_MS} AS day_ms, COUNT(*) AS n
         FROM users u
        WHERE u.created_at >= ?1 AND ${notQa('u.email')}
        GROUP BY 1`,
      p0 < series0 ? p0 : series0),

    // The only raw-event read: five minutes of it, by the time index.
    one(`SELECT COUNT(DISTINCT e.user_id) AS players, COUNT(DISTINCT e.game_id) AS games
           FROM analytics_events e JOIN users u ON u.id = e.user_id
          WHERE e.created_at_ms > ?1 AND e.kind = 'heartbeat' AND ${notQa('u.email')}`,
      now - 5 * 60_000),

    // "Quiet" = running, but no real player has acted in 24 hours.
    one(`SELECT SUM(g.status = 'active') AS active,
                SUM(g.status = 'completed') AS completed,
                SUM(g.status = 'active' AND COALESCE(s.last_action_ms, 0) < ?1) AS quiet
           FROM games g LEFT JOIN analytics_game_seen s ON s.game_id = g.id
          WHERE g.status IN ('active', 'completed')
            AND EXISTS (SELECT 1 FROM game_factions f JOIN users u ON u.id = f.user_id
                         WHERE f.game_id = g.id AND ${notQa('u.email')})`,
      now - DAY_MS),

    one(`SELECT COUNT(*) AS total, COALESCE(SUM(granted_at >= ?1), 0) AS week
           FROM user_entitlements WHERE source = 'stripe'`,
      now - 7 * DAY_MS),

    q('SELECT hour_ms, minutes FROM analytics_heat WHERE hour_ms >= ?1', heat0),

    // All-time total too: the "never used anywhere" warning is about
    // history, while the ranking is about the last 30 days.
    q(`SELECT kind,
              SUM(CASE WHEN day_ms >= ?1 THEN n ELSE 0 END) AS n30,
              SUM(CASE WHEN day_ms >= ?2 AND day_ms < ?1 THEN n ELSE 0 END) AS prev30,
              SUM(n) AS total
         FROM analytics_kind_day
        GROUP BY kind
        ORDER BY n30 DESC, total DESC`,
      usage0, usagePrev0),

    // Weekly signup cohorts. "Came back after N days" = a heartbeat N or
    // more days after the account was made, the same test the old table
    // used per player. e_N counts members old enough to have had the
    // chance, so a two-day-old account is not read as churned.
    q(`SELECT CAST((u.created_at - ${MONDAY_MS}) / ${WEEK_MS} AS INTEGER) * ${WEEK_MS} + ${MONDAY_MS} AS week_ms,
              COUNT(*) AS size,
              SUM(EXISTS (SELECT 1 FROM game_factions f WHERE f.user_id = u.id)) AS seated,
              SUM(s.last_beat_ms IS NOT NULL) AS played,
              SUM(COALESCE(s.last_beat_ms >= u.created_at + ${DAY_MS}, 0)) AS r1,
              SUM(COALESCE(s.last_beat_ms >= u.created_at + ${7 * DAY_MS}, 0)) AS r7,
              SUM(COALESCE(s.last_beat_ms >= u.created_at + ${14 * DAY_MS}, 0)) AS r14,
              SUM(COALESCE(s.last_beat_ms >= u.created_at + ${28 * DAY_MS}, 0)) AS r28,
              SUM(u.created_at <= ?2 - ${DAY_MS}) AS e1,
              SUM(u.created_at <= ?2 - ${7 * DAY_MS}) AS e7,
              SUM(u.created_at <= ?2 - ${14 * DAY_MS}) AS e14,
              SUM(u.created_at <= ?2 - ${28 * DAY_MS}) AS e28
         FROM users u LEFT JOIN analytics_user_seen s ON s.user_id = u.id
        WHERE u.created_at >= ?1 AND ${notQa('u.email')}
        GROUP BY 1 ORDER BY 1 DESC`,
      cohort0, now),

    // Where players came from (users.signup_source, worker/attribution.js).
    // All time: a post is compared with other posts long after its week.
    q(`SELECT COALESCE(u.signup_source, '') AS source,
              COUNT(*) AS signups,
              SUM(u.created_at > ?1) AS signups_30d,
              SUM(EXISTS (SELECT 1 FROM game_factions f WHERE f.user_id = u.id)) AS joined,
              SUM(COALESCE(s.last_beat_ms >= u.created_at + ${DAY_MS}, 0)) AS came_back,
              MAX(u.created_at) AS latest_ms,
              GROUP_CONCAT(DISTINCT u.signup_referrer) AS referrers
         FROM users u LEFT JOIN analytics_user_seen s ON s.user_id = u.id
        WHERE ${notQa('u.email')}
        GROUP BY 1
        ORDER BY signups DESC
        LIMIT 60`,
      now - 30 * DAY_MS),
  ]);

  // 7x24 UTC grid; the client shifts it to the viewer's clock.
  const heatGrid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const r of heat) {
    const d = new Date(r.hour_ms);
    heatGrid[d.getUTCDay()][d.getUTCHours()] += r.minutes;
  }

  // Dense 30-day series (days nobody played are zeros, not gaps), with
  // signups folded in so one chart can show both.
  const byDay = new Map(series.map(r => [r.day_ms, r]));
  const signupsByDay = new Map(signups.map(r => [r.day_ms, r.n]));
  const daily = [];
  for (let d = series0; d <= today; d += DAY_MS) {
    const r = byDay.get(d);
    daily.push({
      day_ms: d,
      players: r?.players ?? 0,
      minutes: r?.minutes ?? 0,
      actions: r?.actions ?? 0,
      signups: signupsByDay.get(d) ?? 0,
    });
  }
  const sumSignups = (a, b) => signups.reduce((s, r) => s + (r.day_ms >= a && r.day_ms < b ? r.n : 0), 0);

  const through = Number(state?.through_ms) || 0;
  return json({
    now,
    rollup: { through_ms: through, behind_ms: through ? Math.max(0, now - through) : null },
    kpis: {
      online_now: online?.players ?? 0,
      games_online_now: online?.games ?? 0,
      players_today: players?.today ?? 0,
      players_week: players?.week ?? 0,
      players_prev_week: players?.prev_week ?? 0,
      players_month: players?.month ?? 0,
      minutes_today: players?.minutes_today ?? 0,
      minutes_week: players?.minutes_week ?? 0,
      minutes_prev_week: players?.minutes_prev_week ?? 0,
      signups_week: sumSignups(w0, today),
      signups_prev_week: sumSignups(p0, w0),
      signups_today: signupsByDay.get(today) ?? 0,
      games_active: games?.active ?? 0,
      games_quiet: games?.quiet ?? 0,
      games_completed: games?.completed ?? 0,
      commissions_total: commission?.total ?? 0,
      commissions_week: commission?.week ?? 0,
    },
    daily,
    heat_grid: heatGrid,
    usage: usage.slice(0, 80),
    cohorts,
    sources,
  });
}

function floorWeek(ms) {
  return Math.floor((ms - MONDAY_MS) / WEEK_MS) * WEEK_MS + MONDAY_MS;
}

// ---------------------------------------------------------------------------
// Shared paging helpers
// ---------------------------------------------------------------------------
function intParam(url, name, dflt, min, max) {
  const x = parseInt(url.searchParams.get(name) ?? '', 10);
  return Number.isFinite(x) ? Math.max(min, Math.min(max, x)) : dflt;
}
/** A LIKE pattern for a free-text search, with the metacharacters
 *  escaped: a search for "%" should find a literal %, not everything. */
function likeParam(url) {
  const raw = (url.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 80);
  return { raw, like: `%${raw.replace(/[\\%_]/g, m => `\\${m}`)}%` };
}
const placeholders = (n) => Array.from({ length: n }, (_, i) => `?${i + 1}`).join(',');
/** Page size cap. A page's ids are bound as parameters alongside one
 *  more value, and D1 allows 100 bound parameters per statement. */
const MAX_PAGE = 50;

// ---------------------------------------------------------------------------
// GET /api/admin/games?status=active|completed&q=&sort=&limit=&offset=
// ---------------------------------------------------------------------------
const GAME_SORTS = {
  // Most recently touched by a real player first; never-touched last.
  activity: 'COALESCE(s.last_action_ms, s.last_beat_ms, 0) DESC, g.next_tick_at DESC',
  players: 'COALESCE(h.humans, 0) DESC, COALESCE(s.last_action_ms, 0) DESC',
  newest: 'r.created_at DESC',
  longest: 'g.current_tick DESC',
};

async function handleAdminGames(req, env, { session, url }) {
  const gate = requireAdmin(session);
  if (gate) return gate;
  const now = Date.now();
  const status = url.searchParams.get('status') === 'completed' ? 'completed' : 'active';
  const sortKey = GAME_SORTS[url.searchParams.get('sort')] ? url.searchParams.get('sort') : 'activity';
  const limit = intParam(url, 'limit', 25, 1, MAX_PAGE);
  const offset = intParam(url, 'offset', 0, 0, 1_000_000);
  const { raw, like } = likeParam(url);

  // One FROM/WHERE for the page and the count, so the total can never
  // disagree with the rows it claims to count.
  const from = `
      FROM games g JOIN rooms r ON r.id = g.id
      LEFT JOIN analytics_game_seen s ON s.game_id = g.id
      ${sortKey === 'players'
        ? `LEFT JOIN (SELECT game_id, COUNT(*) AS humans FROM game_factions
                       WHERE user_id IS NOT NULL AND status != 'vacated' GROUP BY game_id) h
             ON h.game_id = g.id`
        : ''}
     WHERE g.status = ?1
       AND (?2 = '' OR LOWER(r.name) LIKE ?3 ESCAPE '\\' OR g.id = ?2)
       AND EXISTS (SELECT 1 FROM game_factions f JOIN users u ON u.id = f.user_id
                    WHERE f.game_id = g.id AND ${notQa('u.email')})`;

  const [page, count] = await Promise.all([
    env.DB.prepare(`SELECT g.id ${from} ORDER BY ${GAME_SORTS[sortKey]} LIMIT ?4 OFFSET ?5`)
      .bind(status, raw, like, limit, offset).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n ${from}`).bind(status, raw, like).first(),
  ]);
  const ids = (page.results ?? []).map(r => r.id);
  const total = count?.n ?? 0;
  if (ids.length === 0) return json({ now, total, games: [], sparks: {} });

  // Details for THIS page only. Correlated subqueries are fine at 25 rows
  // and would not be across every game on the server.
  const d14 = floorDay(now) - 13 * DAY_MS;
  const inIds = placeholders(ids.length);
  const after = `?${ids.length + 1}`;
  const [detail, recent] = await Promise.all([
    env.DB.prepare(
      `SELECT g.id, r.name, g.status, g.current_tick, g.tick_interval_ms,
              g.next_tick_at, g.victory_type, r.created_at,
              (SELECT COUNT(*) FROM game_factions f
                WHERE f.game_id = g.id AND f.user_id IS NOT NULL AND f.status != 'vacated') AS humans,
              (SELECT COUNT(*) FROM game_factions f
                WHERE f.game_id = g.id AND f.status = 'active') AS factions,
              s.last_action_ms, s.last_beat_ms AS last_heartbeat_ms,
              (SELECT MAX(c.created_at_ms) FROM chronicle_entries c
                WHERE c.game_id = g.id AND c.kind = 'ship_destroyed') AS last_combat_ms,
              (SELECT MAX(sp.proposed_at_tick) FROM senate_proposals sp
                WHERE sp.game_id = g.id) AS last_proposal_tick
         FROM games g JOIN rooms r ON r.id = g.id
         LEFT JOIN analytics_game_seen s ON s.game_id = g.id
        WHERE g.id IN (${inIds})`,
    ).bind(...ids).all(),
    env.DB.prepare(
      `SELECT game_id, SUM(actions) AS actions_14d, SUM(minutes) AS minutes_14d,
              COUNT(DISTINCT user_id) AS players_14d
         FROM analytics_user_day
        WHERE game_id IN (${inIds}) AND day_ms >= ${after} AND qa = 0
        GROUP BY game_id`,
    ).bind(...ids, d14).all(),
  ]);

  const recentBy = new Map((recent.results ?? []).map(r => [r.game_id, r]));
  const byId = new Map((detail.results ?? []).map(g => [g.id, {
    ...g,
    actions_14d: recentBy.get(g.id)?.actions_14d ?? 0,
    minutes_14d: recentBy.get(g.id)?.minutes_14d ?? 0,
    players_14d: recentBy.get(g.id)?.players_14d ?? 0,
  }]));
  const games = ids.map(id => byId.get(id)).filter(Boolean);

  // Credits trend for running games on this page: last 30 recorded ticks,
  // straight off faction_metrics' primary key.
  const sparks = {};
  await Promise.all(games.filter(g => g.status === 'active').map(async (g) => {
    try {
      const rows = await env.DB.prepare(
        `SELECT tick_number, SUM(gold) AS v FROM faction_metrics
          WHERE game_id = ? AND tick_number > ?
          GROUP BY tick_number ORDER BY tick_number`,
      ).bind(g.id, (g.current_tick ?? 0) - 30).all();
      sparks[g.id] = (rows.results ?? []).map(r => [r.tick_number, r.v]);
    } catch (e) { console.error('spark query failed', e); }
  }));

  return json({ now, total, games, sparks });
}

// ---------------------------------------------------------------------------
// GET /api/admin/players?scope=active|all&q=&sort=&limit=&offset=
// ---------------------------------------------------------------------------
const PLAYER_SORTS = {
  time: 'COALESCE(a.minutes, 0) DESC, COALESCE(s.last_beat_ms, 0) DESC',
  recent: 'COALESCE(s.last_beat_ms, 0) DESC',
  days: 'COALESCE(a.days, 0) DESC, COALESCE(a.minutes, 0) DESC',
  newest: 'u.created_at DESC',
};

async function handleAdminPlayers(req, env, { session, url }) {
  const gate = requireAdmin(session);
  if (gate) return gate;
  const now = Date.now();
  const today = floorDay(now);
  const d14 = today - 13 * DAY_MS; // 14 days including today
  const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'active';
  const sortKey = PLAYER_SORTS[url.searchParams.get('sort')] ? url.searchParams.get('sort') : 'time';
  const limit = intParam(url, 'limit', 25, 1, MAX_PAGE);
  const offset = intParam(url, 'offset', 0, 0, 1_000_000);
  const { raw, like } = likeParam(url);

  const from = `
      FROM users u
      ${scope === 'active' ? 'JOIN' : 'LEFT JOIN'} (
        SELECT user_id, SUM(minutes) AS minutes, COUNT(DISTINCT day_ms) AS days
          FROM analytics_user_day
         WHERE day_ms >= ?1 AND qa = 0
         GROUP BY user_id
        ${scope === 'active' ? 'HAVING SUM(minutes) > 0' : ''}) a ON a.user_id = u.id
      LEFT JOIN analytics_user_seen s ON s.user_id = u.id
     WHERE ${notQa('u.email')}
       AND (?2 = '' OR LOWER(u.display_name) LIKE ?3 ESCAPE '\\' OR LOWER(u.email) LIKE ?3 ESCAPE '\\')`;

  const [page, count] = await Promise.all([
    env.DB.prepare(
      `SELECT u.id, u.display_name, u.email, u.created_at,
              s.last_beat_ms AS last_played_ms, s.first_beat_ms, s.minutes AS minutes_all
         ${from} ORDER BY ${PLAYER_SORTS[sortKey]} LIMIT ?4 OFFSET ?5`,
    ).bind(d14, raw, like, limit, offset).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n ${from}`).bind(d14, raw, like).first(),
  ]);
  const rows = page.results ?? [];
  const total = count?.n ?? 0;
  if (rows.length === 0) return json({ now, total, players: [] });

  const ids = rows.map(r => r.id);
  const inIds = placeholders(ids.length);
  const after = `?${ids.length + 1}`;
  const [days, seats] = await Promise.all([
    env.DB.prepare(
      `SELECT user_id, day_ms, SUM(minutes) AS minutes, SUM(actions) AS actions
         FROM analytics_user_day
        WHERE user_id IN (${inIds}) AND day_ms >= ${after}
        GROUP BY user_id, day_ms`,
    ).bind(...ids, d14).all(),
    env.DB.prepare(
      `SELECT f.user_id, g.id AS game_id, r.name AS game_name, f.name AS faction_name, f.color
         FROM game_factions f JOIN games g ON g.id = f.game_id JOIN rooms r ON r.id = g.id
        WHERE f.user_id IN (${inIds}) AND g.status = 'active' AND f.status != 'vacated'`,
    ).bind(...ids).all(),
  ]);

  // 14 buckets, oldest first, so the client can draw a strip without
  // doing calendar arithmetic of its own.
  const strip = new Map(ids.map(id => [id, new Array(14).fill(0)]));
  const actions = new Map(ids.map(id => [id, 0]));
  for (const r of days.results ?? []) {
    const i = Math.round((r.day_ms - d14) / DAY_MS);
    if (i >= 0 && i < 14) strip.get(r.user_id)[i] += r.minutes;
    actions.set(r.user_id, actions.get(r.user_id) + (r.actions ?? 0));
  }
  const gamesBy = new Map();
  for (const s of seats.results ?? []) {
    if (!gamesBy.has(s.user_id)) gamesBy.set(s.user_id, []);
    gamesBy.get(s.user_id).push({ id: s.game_id, name: s.game_name, faction: s.faction_name, color: s.color });
  }

  const players = rows.map(r => {
    const d = strip.get(r.id);
    const sum = (a, b) => d.slice(a, b).reduce((x, y) => x + y, 0);
    return {
      ...r,
      days_14: d,
      minutes_14d: sum(0, 14),
      // Last seven days including today, against the seven before.
      minutes_7d: sum(7, 14),
      minutes_prior7: sum(0, 7),
      active_days_14d: d.filter(Boolean).length,
      actions_14d: actions.get(r.id),
      games: gamesBy.get(r.id) ?? [],
    };
  });
  return json({ now, total, players, day0_ms: d14 });
}

export const routes = [
  { method: 'GET', pattern: '/api/admin/overview', auth: 'required', handle: handleOverview },
  { method: 'GET', pattern: '/api/admin/games', auth: 'required', handle: handleAdminGames },
  { method: 'GET', pattern: '/api/admin/players', auth: 'required', handle: handleAdminPlayers },
];
