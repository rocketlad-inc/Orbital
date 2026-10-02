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
/** The game said no (0152). NULL status = logged before outcomes were
 *  recorded, which is "unknown", so it never counts as a rejection. */
const REJECTED = 'COALESCE(e.status, 0) >= 400';

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
       (day_ms, user_id, game_id, minutes, actions, last_beat_ms, last_action_ms, qa, rejected, judged)
     SELECT ${day}, e.user_id, COALESCE(e.game_id, ''),
            SUM(e.kind = 'heartbeat'),
            SUM(${IS_ACTION}),
            MAX(CASE WHEN e.kind = 'heartbeat' THEN e.created_at_ms END),
            MAX(CASE WHEN ${IS_ACTION} THEN e.created_at_ms END),
            COALESCE(MAX(${isQa('u.email')}), 0),
            SUM(${IS_ACTION} AND ${REJECTED}),
            SUM(${IS_ACTION} AND e.status IS NOT NULL)
       FROM analytics_events e LEFT JOIN users u ON u.id = e.user_id
      WHERE ${range} AND e.user_id IS NOT NULL AND ${guard}
      GROUP BY 1, 2, 3
     ON CONFLICT (day_ms, user_id, game_id) DO UPDATE SET
       minutes = minutes + excluded.minutes,
       actions = actions + excluded.actions,
       rejected = rejected + excluded.rejected,
       judged = judged + excluded.judged,
       last_beat_ms = ${later('last_beat_ms')},
       last_action_ms = ${later('last_action_ms')}`,

    `INSERT INTO analytics_heat (hour_ms, minutes)
     SELECT CAST(e.created_at_ms / ${HOUR_MS} AS INTEGER) * ${HOUR_MS}, COUNT(*)
       FROM analytics_events e JOIN users u ON u.id = e.user_id
      WHERE ${range} AND e.kind = 'heartbeat' AND ${notQa('u.email')} AND ${guard}
      GROUP BY 1
     ON CONFLICT (hour_ms) DO UPDATE SET minutes = minutes + excluded.minutes`,

    // Events with no user (rare, system-side) count, as they always did.
    `INSERT INTO analytics_kind_day (day_ms, kind, n, rejected, judged)
     SELECT ${day}, e.kind, COUNT(*), SUM(${REJECTED}), SUM(e.status IS NOT NULL)
       FROM analytics_events e LEFT JOIN users u ON u.id = e.user_id
      WHERE ${range} AND ${IS_ACTION}
        AND COALESCE(${isQa('u.email')}, 0) = 0 AND ${guard}
      GROUP BY 1, 2
     ON CONFLICT (day_ms, kind) DO UPDATE SET
       n = n + excluded.n, rejected = rejected + excluded.rejected,
       judged = judged + excluded.judged`,

    // Where the game said no (0152), by action, code and masked reason.
    // Real players only: a harness probing edge cases on purpose would
    // otherwise top this list every day.
    `INSERT INTO analytics_friction_day (day_ms, kind, code, reason, n)
     SELECT ${day}, e.kind, COALESCE(e.err_code, 'http_' || e.status), COALESCE(e.err_reason, ''), COUNT(*)
       FROM analytics_events e LEFT JOIN users u ON u.id = e.user_id
      WHERE ${range} AND ${IS_ACTION} AND ${REJECTED}
        AND COALESCE(${isQa('u.email')}, 0) = 0 AND ${guard}
      GROUP BY 1, 2, 3, 4
     ON CONFLICT (day_ms, kind, code, reason) DO UPDATE SET n = n + excluded.n`,

    // Each player's first SUCCESSFUL use of each action: the new-player
    // journey. A refused attempt is not a first step taken.
    `INSERT INTO analytics_user_first (user_id, kind, first_ms, n)
     SELECT e.user_id, e.kind, MIN(e.created_at_ms), COUNT(*)
       FROM analytics_events e
      WHERE ${range} AND ${IS_ACTION} AND NOT (${REJECTED})
        AND e.user_id IS NOT NULL AND ${guard}
      GROUP BY e.user_id, e.kind
     ON CONFLICT (user_id, kind) DO UPDATE SET
       first_ms = MIN(first_ms, excluded.first_ms), n = n + excluded.n`,

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

  const journey0 = today - 29 * DAY_MS; // signups in the last 30 days
  const friction0 = today - 6 * DAY_MS; // the last 7 days, today included
  const [
    state, players, series, signups, online, games, commission,
    heat, usage, cohorts, sources, journey, journeyTimes, friction, crashes,
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
              SUM(CASE WHEN day_ms >= ?1 THEN rejected ELSE 0 END) AS rejected30,
              SUM(CASE WHEN day_ms >= ?1 THEN judged ELSE 0 END) AS judged30,
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

    // The new-player journey: of everyone who signed up in the last 30
    // days, how many reached each first step. Steps are FIRST SUCCESSFUL
    // uses (analytics_user_first), so a refused attempt is not a step.
    one(`SELECT COUNT(*) AS signed_up,
                ${JOURNEY_STEPS.map(s => `SUM(${s.sql}) AS ${s.id}`).join(', ')},
                SUM(u.created_at <= ?2 - ${DAY_MS}) AS e1,
                SUM(u.created_at <= ?2 - ${7 * DAY_MS}) AS e7
           FROM users u LEFT JOIN analytics_user_seen s ON s.user_id = u.id
          WHERE u.created_at >= ?1 AND ${notQa('u.email')}`,
      journey0, now),

    // How long each first step took after signing up, for the medians.
    q(`SELECT f.kind, f.first_ms - u.created_at AS dt
         FROM analytics_user_first f JOIN users u ON u.id = f.user_id
        WHERE u.created_at >= ?1 AND ${notQa('u.email')}
          AND f.kind IN (${JOURNEY_KINDS.map(k => `'${k}'`).join(', ')})`,
      journey0),

    // Where the game said no, last 7 days (0152).
    q(`SELECT kind, code, reason, SUM(n) AS n
         FROM analytics_friction_day
        WHERE day_ms >= ?1
        GROUP BY kind, code, reason
        ORDER BY n DESC
        LIMIT 40`,
      friction0),

    // Real crashes only. client_crashes also carries the Android app's
    // launch breadcrumbs (android:start/step/launch/shell-*): 5,000 rows a
    // week against 3 actual crashes on 2026-10-01.
    q(`SELECT COALESCE(scope, '') AS scope, substr(message, 1, 160) AS message,
              COUNT(*) AS n, COUNT(DISTINCT user_id) AS users,
              MAX(created_at_ms) AS last_ms, MAX(git_sha) AS git_sha
         FROM client_crashes
        WHERE created_at_ms >= ?1 AND ${IS_CRASH}
        GROUP BY 1, 2
        ORDER BY n DESC
        LIMIT 12`,
      now - 7 * DAY_MS),
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

  // Median time from signup to each first step.
  const medianOf = (kinds) => {
    const xs = journeyTimes.filter(r => kinds.includes(r.kind)).map(r => r.dt).filter(x => x >= 0);
    // A step reached through several action kinds counts its earliest.
    return xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null;
  };
  const journeySteps = JOURNEY_STEPS.map(s => ({
    id: s.id,
    label: s.label,
    n: journey?.[s.id] ?? 0,
    median_ms: s.kinds ? medianOf(s.kinds) : null,
  }));

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
    journey: {
      signed_up: journey?.signed_up ?? 0,
      eligible_1d: journey?.e1 ?? 0,
      eligible_7d: journey?.e7 ?? 0,
      steps: journeySteps,
    },
    friction,
    crashes,
  });
}

/** A real crash, not a launch breadcrumb (see the crashes query). */
const IS_CRASH = `((COALESCE(scope, '') NOT LIKE 'android:%' AND COALESCE(scope, '') NOT IN ('selftest'))
                  OR scope IN ('android:crash', 'android:error'))`;

/** The first things a new player should do, in the order the game asks
 *  them to. Each is "did it at least once, successfully". */
const firstUse = (kinds) =>
  `EXISTS (SELECT 1 FROM analytics_user_first f WHERE f.user_id = u.id
            AND f.kind IN (${kinds.map(k => `'${k}'`).join(', ')}))`;
const JOURNEY_STEPS = [
  { id: 'played', label: 'Opened the game', sql: 'COALESCE(s.minutes, 0) > 0' },
  { id: 'seated', label: 'Took a seat in a game',
    sql: 'EXISTS (SELECT 1 FROM game_factions gf WHERE gf.user_id = u.id)' },
  { id: 'played30', label: 'Played 30+ minutes', sql: 'COALESCE(s.minutes, 0) >= 30' },
  { id: 'built', label: 'Queued a ship', kinds: ['POST bodies/build'] },
  { id: 'researched', label: 'Started research', kinds: ['POST research'] },
  { id: 'building', label: 'Queued a building', kinds: ['POST settlements/buildings'] },
  { id: 'moved', label: 'Sent ships somewhere', kinds: ['POST transfers', 'PATCH ships/orders', 'POST fleets/orders', 'PATCH fleets/orders'] },
  { id: 'colony', label: 'Founded a colony', kinds: ['POST bodies/settlement'] },
  { id: 'social', label: 'Dealt with another empire', kinds: ['POST trades', 'POST trades/accept', 'POST market', 'POST market/take', 'POST messages', 'POST wars/declare', 'POST senate/proposals/vote'] },
  { id: 'back1', label: 'Came back the next day', sql: `COALESCE(s.last_beat_ms >= u.created_at + ${DAY_MS}, 0)` },
  { id: 'back7', label: 'Still playing a week later', sql: `COALESCE(s.last_beat_ms >= u.created_at + ${7 * DAY_MS}, 0)` },
].map(s => ({ ...s, sql: s.sql ?? firstUse(s.kinds) }));
const JOURNEY_KINDS = [...new Set(JOURNEY_STEPS.flatMap(s => s.kinds ?? []))];

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
      `SELECT user_id, day_ms, SUM(minutes) AS minutes, SUM(actions) AS actions,
              SUM(rejected) AS rejected, SUM(judged) AS judged
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
  const rejected = new Map(ids.map(id => [id, 0]));
  const judged = new Map(ids.map(id => [id, 0]));
  for (const r of days.results ?? []) {
    const i = Math.round((r.day_ms - d14) / DAY_MS);
    if (i >= 0 && i < 14) strip.get(r.user_id)[i] += r.minutes;
    actions.set(r.user_id, actions.get(r.user_id) + (r.actions ?? 0));
    rejected.set(r.user_id, rejected.get(r.user_id) + (r.rejected ?? 0));
    judged.set(r.user_id, judged.get(r.user_id) + (r.judged ?? 0));
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
      rejected_14d: rejected.get(r.id),
      judged_14d: judged.get(r.id),
      games: gamesBy.get(r.id) ?? [],
    };
  });
  return json({ now, total, players, day0_ms: d14 });
}

// ---------------------------------------------------------------------------
// GET /api/admin/games/:gameId/story — how each empire's game WENT.
//
// The analytics endpoint answers balance questions (yields, combat
// maths, loadouts). This one answers the playtesting question: for each
// empire, what happened to it, did it hit trouble, and did it come back?
// For each human: how far did they get into the game's basics, how long
// did each first step take, and where did the game refuse them?
//
// Everything is scoped to one game and read through game-keyed indexes,
// so the cost is the size of this game, not of the database.
// ---------------------------------------------------------------------------

/** Chronicle kinds worth a marker on an empire's timeline. Routine
 *  traffic (ship_built, tech_advanced, ship_damaged) is counted instead. */
const STORY_KINDS = [
  'game_started', 'faction_joined', 'settlement_built', 'settlement_destroyed',
  'settlement_seized', 'settlement_razed', 'faction_eliminated', 'faction_revived',
  'fleet_arrears', 'war_declared', 'war_ended', 'treaty_signed', 'terraform_complete',
  'megastructure_complete', 'dyson_milestone', 'victory', 'ship_rush_botched',
  'settle_refused', 'trade_route_stalled', 'hold_full', 'captain_lost', 'secret_discovered',
];
const COUNT_KINDS = ['ship_built', 'ship_destroyed', 'tech_advanced', 'building_completed', 'trade_route_run', 'meteoroid_found'];
/** Points per empire on the trajectory chart. */
const STORY_POINTS = 160;

/** Only the payload fields the timeline shows; never the whole blob. */
function storyDetail(kind, raw) {
  let p = {};
  try { p = JSON.parse(raw || '{}'); } catch { /* keep {} */ }
  switch (kind) {
    case 'settlement_built': case 'settlement_destroyed': case 'settlement_razed': case 'settlement_seized':
      return { name: p.settlement_name ?? null, body: p.body_name ?? null, type: p.settlement_type ?? null };
    case 'faction_eliminated': return { cause: p.cause ?? null };
    case 'fleet_arrears': return { entered: p.entered !== false, metal: p.arrears_metal ?? 0, gold: p.arrears_gold ?? 0 };
    case 'terraform_complete': case 'captain_lost': return { body: p.body_name ?? null };
    case 'settle_refused': case 'hold_full': return { reason: p.reason ?? null };
    case 'ship_rush_botched': return { ship_class: p.ship_class ?? null };
    default: return {};
  }
}

async function handleGameStory(req, env, { session, params }) {
  const gate = requireAdmin(session);
  if (gate) return gate;
  const gameId = params.gameId;
  const DB = env.DB;
  const now = Date.now();
  const game = await DB.prepare(
    `SELECT g.id, r.name, g.status, g.current_tick, g.tick_interval_ms, g.started_at,
            g.completed_at, g.victory_type, g.winner_faction_id
       FROM games g JOIN rooms r ON r.id = g.id WHERE g.id = ?`,
  ).bind(gameId).first();
  if (!game) return err(404, 'not_found', 'no such game');
  const stride = Math.max(1, Math.ceil((game.current_tick || 1) / STORY_POINTS));
  const q = (sql, ...args) => DB.prepare(sql).bind(...args).all().then(r => r.results ?? []);
  const list = (xs) => xs.map(k => `'${k}'`).join(', ');

  const [
    factions, metrics, events, counts, kills, arrearsTicks, econNow, wars,
    firsts, totals, days, friction, ticks,
  ] = await Promise.all([
    q(`SELECT f.id, f.name, f.color, f.status, f.slot, f.user_id, f.joined_at,
              u.display_name AS player_name, COALESCE(${isQa('u.email')}, 0) AS qa
         FROM game_factions f LEFT JOIN users u ON u.id = f.user_id
        WHERE f.game_id = ? ORDER BY f.slot`, gameId),
    // Every stride-th tick plus the final stretch, so "now" is exact.
    q(`SELECT tick_number AS t, faction_id AS f, settlements AS s, ships AS sh,
              metal AS m, gold AS g, science AS sc
         FROM faction_metrics
        WHERE game_id = ?1 AND (tick_number % ?2 = 0 OR tick_number >= ?3)
        ORDER BY tick_number`,
      gameId, stride, (game.current_tick ?? 0) - stride),
    q(`SELECT tick_number AS t, kind, actor_faction_id AS f, target_faction_id AS o, payload
         FROM chronicle_entries
        WHERE game_id = ? AND kind IN (${list(STORY_KINDS)})
        ORDER BY tick_number
        LIMIT 1500`, gameId),
    q(`SELECT actor_faction_id AS f, kind, COUNT(*) AS n
         FROM chronicle_entries
        WHERE game_id = ? AND kind IN (${list(COUNT_KINDS)})
        GROUP BY 1, 2`, gameId),
    // Ship losses with the killer's side, bucketed onto the chart's ticks.
    q(`SELECT actor_faction_id AS f, json_extract(payload, '$.killer_faction_id') AS k,
              (tick_number / ?2) * ?2 AS t, COUNT(*) AS n
         FROM chronicle_entries
        WHERE game_id = ?1 AND kind = 'ship_destroyed'
        GROUP BY 1, 2, 3`, gameId, stride),
    q(`SELECT faction_id AS f, tick_number AS t
         FROM faction_economy_ticks
        WHERE game_id = ? AND (arrears_metal > 0 OR arrears_gold > 0)
        ORDER BY tick_number
        LIMIT 5000`, gameId),
    q(`SELECT e.faction_id AS f, e.pool_metal, e.pool_gold, e.upkeep_metal, e.upkeep_gold,
              e.arrears_metal, e.arrears_gold
         FROM faction_economy_ticks e
        WHERE e.game_id = ?1
          AND e.tick_number = (SELECT MAX(tick_number) FROM faction_economy_ticks WHERE game_id = ?1)`,
      gameId),
    q(`SELECT faction_a AS a, faction_b AS b, declared_by, declared_at_tick AS t0,
              ended_at_tick AS t1, origin
         FROM game_wars WHERE game_id = ? ORDER BY declared_at_tick`, gameId),
    // First SUCCESSFUL use of each basic, per player, in this game.
    q(`SELECT user_id, kind,
              MIN(CASE WHEN COALESCE(status, 0) < 400 THEN created_at_ms END) AS first_ms,
              COUNT(*) AS n,
              SUM(COALESCE(status, 0) >= 400) AS rejected
         FROM analytics_events
        WHERE game_id = ? AND user_id IS NOT NULL
          AND kind IN (${list(JOURNEY_KINDS)})
        GROUP BY user_id, kind`, gameId),
    q(`SELECT user_id, SUM(minutes) AS minutes, SUM(actions) AS actions,
              SUM(rejected) AS rejected, SUM(judged) AS judged,
              COUNT(DISTINCT CASE WHEN minutes > 0 THEN day_ms END) AS days,
              MIN(day_ms) AS first_day_ms, MAX(last_beat_ms) AS last_beat_ms,
              MAX(last_action_ms) AS last_action_ms
         FROM analytics_user_day WHERE game_id = ? GROUP BY user_id`, gameId),
    q(`SELECT user_id, day_ms, minutes, actions, rejected
         FROM analytics_user_day WHERE game_id = ? ORDER BY day_ms`, gameId),
    // Reads the partial index of rejected actions (0152), never the
    // game's heartbeats.
    q(`SELECT user_id, kind, COALESCE(err_code, 'http_' || status) AS code,
              COALESCE(err_reason, '') AS reason, COUNT(*) AS n, MAX(created_at_ms) AS last_ms
         FROM analytics_events
        WHERE game_id = ? AND status >= 400
        GROUP BY 1, 2, 3, 4
        ORDER BY n DESC
        LIMIT 200`, gameId),
    // Tick -> wall clock, to put a player's first steps on the same
    // axis as their empire.
    q(`SELECT tick_number AS t, COALESCE(completed_at, started_at, scheduled_at) AS ms
         FROM game_ticks
        WHERE game_id = ?1 AND tick_number % ?2 = 0 AND status = 'completed'
        ORDER BY tick_number`, gameId, stride),
  ]);

  // The trajectory per empire: [tick, settlements, ships, metal, credits, science].
  const series = {};
  for (const r of metrics) (series[r.f] ??= []).push([r.t, r.s, r.sh, r.m, r.g, r.sc]);

  const tally = {};
  const bump = (f, key, n) => { if (f) (tally[f] ??= {})[key] = (tally[f][key] ?? 0) + n; };
  for (const r of counts) bump(r.f, r.kind, r.n);
  for (const r of kills) bump(r.k, 'kills', r.n);
  const losses = {};
  for (const r of kills) (losses[r.f] ??= []).push([r.t, r.n]);

  const arrears = {};
  for (const r of arrearsTicks) (arrears[r.f] ??= []).push(r.t);
  const econ = {};
  for (const r of econNow) { const { f, ...rest } = r; econ[f] = rest; }

  // Per human: first steps, totals, a day-by-day strip, refusals.
  const byUser = new Map(factions.filter(f => f.user_id).map(f => [f.user_id, {
    user_id: f.user_id, faction_id: f.id, name: f.player_name, qa: f.qa,
    firsts: {}, tries: {}, refused: {}, days: [], friction: [], totals: null,
  }]));
  for (const r of firsts) {
    const p = byUser.get(r.user_id);
    if (!p) continue;
    for (const step of JOURNEY_STEPS) {
      if (!step.kinds?.includes(r.kind)) continue;
      if (r.first_ms != null && (p.firsts[step.id] == null || r.first_ms < p.firsts[step.id])) p.firsts[step.id] = r.first_ms;
      p.tries[step.id] = (p.tries[step.id] ?? 0) + r.n;
      p.refused[step.id] = (p.refused[step.id] ?? 0) + (r.rejected ?? 0);
    }
  }
  for (const r of totals) { const p = byUser.get(r.user_id); if (p) p.totals = r; }
  for (const r of days) { const p = byUser.get(r.user_id); if (p) p.days.push([r.day_ms, r.minutes, r.actions, r.rejected]); }
  for (const r of friction) { const p = byUser.get(r.user_id); if (p) p.friction.push(r); }

  return json({
    now,
    game,
    stride,
    factions,
    series,
    events: events.map(e => ({ t: e.t, kind: e.kind, f: e.f, o: e.o, d: storyDetail(e.kind, e.payload) })),
    tally,
    losses,
    arrears,
    econ,
    wars,
    ticks: ticks.map(r => [r.t, r.ms]),
    journey_steps: JOURNEY_STEPS.filter(s => s.kinds).map(s => ({ id: s.id, label: s.label })),
    players: [...byUser.values()],
  });
}

export const routes = [
  { method: 'GET', pattern: '/api/admin/overview', auth: 'required', handle: handleOverview },
  { method: 'GET', pattern: '/api/admin/games', auth: 'required', handle: handleAdminGames },
  { method: 'GET', pattern: '/api/admin/players', auth: 'required', handle: handleAdminPlayers },
  { method: 'GET', pattern: /^\/api\/admin\/games\/(?<gameId>[^/]+)\/story$/, auth: 'required', handle: handleGameStory },
];
