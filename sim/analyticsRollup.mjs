// ============================================================
// ANALYTICS ROLLUP — does the dashboard still tell the truth?
//
// The admin overview stopped counting analytics_events directly
// (632,550 rows read per load) and now reads rollup tables that a minute
// cron keeps up to date (worker/adminDashboard.js, migration 0150). A
// rollup is only worth having if it gives the SAME answers as counting
// the raw events, so this sim seeds weeks of events — real players, QA
// robots, events outside any game, perf chatter — runs the real rollup
// the way the cron would, and compares every rollup table against a
// recount of the raw rows done here in JavaScript.
//
// Also pinned:
//   - two overlapping cron runs do not double-count (the watermark guard)
//   - events inside the lag window wait for the next pass, then land
//   - clearing the rollups and resetting the watermark rebuilds the same
//   - the overview / games / players handlers agree with the raw counts,
//     page honestly, search, and never show a robot
//
// Run: node sim/analyticsRollup.mjs
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { rollupAnalytics, routes, DAY_MS, ROLLUP_LAG_MS } from '../worker/adminDashboard.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = { DB };

// A fixed "now": 15:30 UTC on a Monday, so weeks and days have edges to
// get wrong.
const NOW = Date.UTC(2026, 8, 28, 15, 30);
const HOUR = 3_600_000;

// ---- people ------------------------------------------------------------
const REAL = ['ann', 'bo', 'cy', 'dee', 'eli', 'fay', 'gus', 'hal'];
const QA = ['robot1', 'agent1'];
const emails = {
  ...Object.fromEntries(REAL.map(u => [u, `${u}@players.test.org`])),
  robot1: 'robot1@example.com',
  agent1: 'agent+probe@agents.orbital.local',
};
// Accounts made across the last seven weeks, so cohorts have members.
const created = {};
REAL.forEach((u, i) => { created[u] = NOW - (48 - i * 6) * DAY_MS - 5 * HOUR; });
created.robot1 = NOW - 20 * DAY_MS;
created.agent1 = NOW - 3 * DAY_MS;
for (const u of [...REAL, ...QA]) {
  await DB.prepare('INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,?,?)')
    .bind(u, emails[u], u.toUpperCase(), 'x', created[u]).run();
}

// ---- games -------------------------------------------------------------
// g1, g2 running with real players; g3 finished; gq a robot-only probe
// game that must never appear on the dashboard.
const GAMES = [
  { id: 'g1aaaaaaaaaa', name: 'Iron Tide', status: 'active', seats: ['ann', 'bo', 'cy'] },
  { id: 'g2aaaaaaaaaa', name: 'Pale Harbor', status: 'active', seats: ['dee', 'eli', 'robot1'] },
  { id: 'g3aaaaaaaaaa', name: 'Old Crown', status: 'completed', seats: ['fay', 'gus'] },
  { id: 'gqaaaaaaaaaa', name: 'Probe Range', status: 'active', seats: ['robot1', 'agent1'] },
];
for (const g of GAMES) {
  await DB.prepare('INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?,?,?,?,?)')
    .bind(g.id, g.name, g.seats[0], NOW - 40 * DAY_MS, NOW).run();
  await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,next_tick_at,created_at,started_at)
                    VALUES (?,?,?,?,?,?,?,?)`)
    .bind(g.id, g.status, 's', 120, HOUR, NOW + HOUR, NOW - 40 * DAY_MS, NOW - 40 * DAY_MS).run();
  let slot = 0;
  for (const u of g.seats) {
    await DB.prepare(`INSERT INTO game_factions (id,game_id,user_id,name,color,slot,status,joined_at)
                      VALUES (?,?,?,?,?,?,'active',0)`)
      .bind(`${g.id}:f${slot}`, g.id, u, `${u} empire`, '#4ecdc4', slot, ).run();
    slot++;
  }
}

// ---- events ------------------------------------------------------------
// Deterministic pseudo-random, so a failure reproduces.
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const KINDS = ['POST bodies/build', 'POST research', 'POST fleets/orders', 'ui/trades', 'POST trades'];
const events = [];
function ev(user, game, kind, at) { events.push({ user, game, kind, at }); }

const seatOf = (u) => GAMES.find(g => g.seats.includes(u))?.id ?? null;
for (let day = 45; day >= 0; day--) {
  for (const u of [...REAL, ...QA]) {
    const start = NOW - day * DAY_MS;
    if (start < created[u]) continue;
    if (rand() < 0.45) continue; // not every player plays every day
    const sessionStart = Math.floor(start - (rand() * 20) * HOUR);
    const minutes = 5 + Math.floor(rand() * 50);
    const game = seatOf(u);
    for (let m = 0; m < minutes; m++) {
      const at = sessionStart + m * 60_000 + Math.floor(rand() * 1000);
      if (at > NOW) break;
      // Some minutes are spent in the lobby, outside any game.
      ev(u, m % 9 === 0 ? null : game, 'heartbeat', at);
      if (rand() < 0.3) ev(u, game, KINDS[Math.floor(rand() * KINDS.length)], at + 10);
      if (rand() < 0.05) ev(u, game, 'POST perf/session', at + 20); // chatter, not an action
    }
  }
}
// A system-side event with no user at all.
ev(null, 'g1aaaaaaaaaa', 'POST research', NOW - 2 * DAY_MS);
// Events inside the lag window: the rollup must NOT count these yet.
ev('ann', 'g1aaaaaaaaaa', 'heartbeat', NOW - 30_000);
ev('ann', 'g1aaaaaaaaaa', 'POST bodies/build', NOW - 20_000);

for (let i = 0; i < events.length; i += 400) {
  await DB.batch(events.slice(i, i + 400).map(e => DB.prepare(
    'INSERT INTO analytics_events (game_id, user_id, kind, created_at_ms) VALUES (?,?,?,?)',
  ).bind(e.game, e.user, e.kind, e.at)));
}
console.log(`seeded ${events.length} events over 46 days\n`);

// ---- the ground truth, counted here from the raw rows -------------------
const isQa = (u) => u != null && QA.includes(u);
const isAction = (k) => k !== 'heartbeat' && !k.startsWith('POST perf');
const dayOf = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;

function truth(through) {
  const counted = events.filter(e => e.at < through);
  const userDay = new Map(), heat = new Map(), kindDay = new Map(), seen = new Map(), gameSeen = new Map();
  for (const e of counted) {
    if (e.user != null) {
      const k = `${dayOf(e.at)}|${e.user}|${e.game ?? ''}`;
      const r = userDay.get(k) ?? { minutes: 0, actions: 0, qa: isQa(e.user) ? 1 : 0 };
      if (e.kind === 'heartbeat') r.minutes++;
      if (isAction(e.kind)) r.actions++;
      userDay.set(k, r);
    }
    if (e.kind === 'heartbeat' && e.user != null && !isQa(e.user)) {
      const h = Math.floor(e.at / HOUR) * HOUR;
      heat.set(h, (heat.get(h) ?? 0) + 1);
    }
    if (isAction(e.kind) && !isQa(e.user)) {
      const k = `${dayOf(e.at)}|${e.kind}`;
      kindDay.set(k, (kindDay.get(k) ?? 0) + 1);
    }
    if (e.kind === 'heartbeat' && e.user != null) {
      const s = seen.get(e.user) ?? { first: Infinity, last: 0, minutes: 0 };
      s.first = Math.min(s.first, e.at); s.last = Math.max(s.last, e.at); s.minutes++;
      seen.set(e.user, s);
    }
    if (e.game && e.user != null && !isQa(e.user)) {
      const g = gameSeen.get(e.game) ?? { beat: null, action: null };
      if (e.kind === 'heartbeat') g.beat = Math.max(g.beat ?? 0, e.at);
      if (isAction(e.kind)) g.action = Math.max(g.action ?? 0, e.at);
      gameSeen.set(e.game, g);
    }
  }
  return { userDay, heat, kindDay, seen, gameSeen };
}

async function rows(sql) { return (await DB.prepare(sql).all()).results; }

async function compareAll(label, through) {
  const t = truth(through);
  const ud = await rows('SELECT * FROM analytics_user_day');
  const udMap = new Map(ud.map(r => [`${r.day_ms}|${r.user_id}|${r.game_id}`, r]));
  let mism = [];
  for (const [k, v] of t.userDay) {
    const r = udMap.get(k);
    if (!r || r.minutes !== v.minutes || r.actions !== v.actions || r.qa !== v.qa) mism.push(`${k}: want ${JSON.stringify(v)} got ${JSON.stringify(r && { m: r.minutes, a: r.actions, qa: r.qa })}`);
  }
  if (ud.length !== t.userDay.size) mism.push(`row count ${ud.length} vs ${t.userDay.size}`);
  check(`${label}: user/day/game minutes and actions match the raw events (${t.userDay.size} rows)`, mism.length === 0, mism.slice(0, 3).join('\n        '));

  const heat = await rows('SELECT * FROM analytics_heat');
  mism = heat.filter(r => t.heat.get(r.hour_ms) !== r.minutes).map(r => `${r.hour_ms}`);
  check(`${label}: play-hour heat matches, robots excluded (${t.heat.size} hours)`,
    mism.length === 0 && heat.length === t.heat.size, `${mism.length} bad, ${heat.length} vs ${t.heat.size}`);

  const kd = await rows('SELECT * FROM analytics_kind_day');
  mism = kd.filter(r => t.kindDay.get(`${r.day_ms}|${r.kind}`) !== r.n).map(r => `${r.day_ms}|${r.kind}`);
  check(`${label}: feature use per day matches, perf chatter and robots excluded`,
    mism.length === 0 && kd.length === t.kindDay.size && !kd.some(r => r.kind.startsWith('POST perf')),
    `${mism.length} bad, ${kd.length} vs ${t.kindDay.size}`);

  const us = await rows('SELECT * FROM analytics_user_seen');
  mism = us.filter(r => {
    const s = t.seen.get(r.user_id);
    return !s || s.first !== r.first_beat_ms || s.last !== r.last_beat_ms || s.minutes !== r.minutes;
  }).map(r => r.user_id);
  check(`${label}: first/last heartbeat per player matches`, mism.length === 0 && us.length === t.seen.size, mism.join(','));

  const gs = await rows('SELECT * FROM analytics_game_seen');
  mism = gs.filter(r => {
    const g = t.gameSeen.get(r.game_id);
    return !g || g.beat !== r.last_beat_ms || g.action !== r.last_action_ms;
  }).map(r => r.game_id);
  check(`${label}: last real activity per game matches; the robot-only game has none`,
    mism.length === 0 && gs.length === t.gameSeen.size && !gs.some(r => r.game_id === 'gqaaaaaaaaaa'),
    mism.join(','));
}

// ---- 1. catch up from nothing, the way the first cron runs would -------
let runs = 0;
let st;
do {
  st = await rollupAnalytics(env, NOW);
  runs++;
} while (st.passes === 5 && runs < 50);
const through = (await DB.prepare('SELECT through_ms FROM analytics_rollup_state').first()).through_ms;
check(`catches up from an empty rollup in ${runs} cron minutes`, through === NOW - ROLLUP_LAG_MS, `through ${through}`);
await compareAll('after catch-up', through);

check('an action inside the lag window is not counted yet',
  (await rows(`SELECT last_action_ms FROM analytics_game_seen WHERE game_id='g1aaaaaaaaaa'`))[0].last_action_ms !== NOW - 20_000);

// ---- 2. the next minute picks the lagged events up ----------------------
await rollupAnalytics(env, NOW + 3 * 60_000);
const t2 = (await DB.prepare('SELECT through_ms FROM analytics_rollup_state').first()).through_ms;
await compareAll('a minute later', t2);
check('the lagged action lands on the next pass',
  (await rows(`SELECT last_action_ms FROM analytics_game_seen WHERE game_id='g1aaaaaaaaaa'`))[0].last_action_ms === NOW - 20_000);

// ---- 3. overlapping cron runs must not double count ---------------------
await DB.batch([
  DB.prepare('DELETE FROM analytics_user_day'), DB.prepare('DELETE FROM analytics_heat'),
  DB.prepare('DELETE FROM analytics_kind_day'), DB.prepare('DELETE FROM analytics_user_seen'),
  DB.prepare('DELETE FROM analytics_game_seen'),
  DB.prepare('UPDATE analytics_rollup_state SET through_ms = 0'),
]);
for (let i = 0; i < 20; i++) {
  // Three "isolates" racing on every minute.
  await Promise.all([rollupAnalytics(env, NOW + 3 * 60_000), rollupAnalytics(env, NOW + 3 * 60_000), rollupAnalytics(env, NOW + 3 * 60_000)]);
}
const t3 = (await DB.prepare('SELECT through_ms FROM analytics_rollup_state').first()).through_ms;
check('rebuilt from zero while three runs raced', t3 === t2, `${t3} vs ${t2}`);
await compareAll('after a racing rebuild', t3);

// ---- 4. the handlers -----------------------------------------------------
const admin = { user_id: 'x', email: 'lcfeeser@gmail.com' };
async function call(path, session = admin) {
  const url = new URL(`https://x${path}`);
  const r = routes.find(x => x.pattern === url.pathname);
  const res = await r.handle(new Request(url), env, { url, session, params: {} });
  return { status: res.status, body: await res.json() };
}

check('a non-admin gets a 404, not a dashboard',
  (await call('/api/admin/overview', { user_id: 'y', email: 'ann@players.test.org' })).status === 404);

// Evaluate the handlers at the same instant the rollup is complete for.
const realNow = Date.now;
Date.now = () => NOW + 3 * 60_000;
try {
  const ov = (await call('/api/admin/overview')).body;
  const today = dayOf(Date.now());
  const w0 = today - 7 * DAY_MS, p0 = today - 14 * DAY_MS;
  const counted = events.filter(e => e.at < t3 && e.user && !isQa(e.user) && e.kind === 'heartbeat');
  const distinct = (a, b) => new Set(counted.filter(e => e.at >= a && e.at < b).map(e => e.user)).size;
  const mins = (a, b) => counted.filter(e => e.at >= a && e.at < b).length;
  check('KPI: players last week = distinct real players with a heartbeat in the 7 complete days',
    ov.kpis.players_week === distinct(w0, today), `${ov.kpis.players_week} vs ${distinct(w0, today)}`);
  check('KPI: players the week before',
    ov.kpis.players_prev_week === distinct(p0, w0), `${ov.kpis.players_prev_week} vs ${distinct(p0, w0)}`);
  check('KPI: minutes played last week vs the week before',
    ov.kpis.minutes_week === mins(w0, today) && ov.kpis.minutes_prev_week === mins(p0, w0));
  check('KPI: players today', ov.kpis.players_today === distinct(today, today + DAY_MS));
  const onlineWant = new Set(events.filter(e => e.kind === 'heartbeat' && e.user && !isQa(e.user)
    && e.at > Date.now() - 5 * 60_000).map(e => e.user)).size;
  check('KPI: online now reads the live events, robots excluded', ov.kpis.online_now === onlineWant, `${ov.kpis.online_now} vs ${onlineWant}`);
  check('KPI: games — two running, one finished; the robot-only game is not counted',
    ov.kpis.games_active === 2 && ov.kpis.games_completed === 1, JSON.stringify(ov.kpis));
  check('daily series is 30 dense days ending today',
    ov.daily.length === 30 && ov.daily[29].day_ms === today && ov.daily.every((d, i) => i === 0 || d.day_ms - ov.daily[i - 1].day_ms === DAY_MS));
  const signupsWant = REAL.filter(u => created[u] >= w0 && created[u] < today).length;
  check('KPI: signups last week are real accounts only', ov.kpis.signups_week === signupsWant, `${ov.kpis.signups_week} vs ${signupsWant}`);
  const cohortSize = ov.cohorts.reduce((s, c) => s + c.size, 0);
  const cohortWant = REAL.filter(u => created[u] >= Date.UTC(2026, 6, 6)).length; // 12 Mondays back from 2026-09-28
  check('cohorts: weekly, Monday-aligned, robots excluded',
    cohortSize === cohortWant && ov.cohorts.every(c => new Date(c.week_ms).getUTCDay() === 1 && c.week_ms % DAY_MS === 0),
    `${cohortSize} vs ${cohortWant}; ${ov.cohorts.map(c => new Date(c.week_ms).toISOString()).join(' ')}`);
  check('cohorts: nobody counts as returned before they were old enough to',
    ov.cohorts.every(c => c.r1 <= c.e1 && c.r7 <= c.e7 && c.r14 <= c.e14 && c.r28 <= c.e28));
  const heatTotal = ov.heat_grid.flat().reduce((a, b) => a + b, 0);
  check('heat grid covers the last 14 days of real play',
    heatTotal === counted.filter(e => e.at >= Math.floor((Date.now() - 14 * DAY_MS) / HOUR) * HOUR).length);
  check('feature usage: no perf chatter, has a 30-day and an all-time count',
    ov.usage.length > 0 && !ov.usage.some(u => u.kind.startsWith('POST perf')) && ov.usage.every(u => u.total >= u.n30));

  const live = (await call('/api/admin/games?status=active')).body;
  check('games: running list excludes the robot-only probe game',
    live.total === 2 && live.games.map(g => g.id).sort().join() === 'g1aaaaaaaaaa,g2aaaaaaaaaa', JSON.stringify(live.games.map(g => g.id)));
  check('games: running games carry a credits sparkline slot', Object.keys(live.sparks).length === 2);
  const paged = (await call('/api/admin/games?status=active&limit=1&offset=1')).body;
  check('games: paging keeps the honest total', paged.total === 2 && paged.games.length === 1);
  const found = (await call('/api/admin/games?status=active&q=harb')).body;
  check('games: search by name', found.total === 1 && found.games[0].name === 'Pale Harbor');
  const done = (await call('/api/admin/games?status=completed')).body;
  check('games: finished list', done.total === 1 && done.games[0].id === 'g3aaaaaaaaaa');
  const g1 = live.games.find(g => g.id === 'g1aaaaaaaaaa');
  check('games: humans counted from seats', g1.humans === 3);

  const everyone = (await call('/api/admin/players?scope=all&limit=50')).body;
  check('players: everyone = the real accounts, never a robot',
    everyone.total === REAL.length && !everyone.players.some(p => QA.includes(p.id)), `${everyone.total}`);
  const active = (await call('/api/admin/players?scope=active&sort=time&limit=50')).body;
  const activeWant = new Set(counted.filter(e => e.at >= today - 13 * DAY_MS).map(e => e.user));
  check('players: active = played in the last 14 days', active.total === activeWant.size, `${active.total} vs ${activeWant.size}`);
  const sortedOk = active.players.every((p, i) => i === 0 || active.players[i - 1].minutes_14d >= p.minutes_14d);
  check('players: sorted by time played', sortedOk);
  const p = active.players[0];
  const pWant = counted.filter(e => e.user === p.id && e.at >= today - 13 * DAY_MS).length;
  check('players: the 14-day strip adds up to time played', p.days_14.length === 14 && p.minutes_14d === pWant, `${p.minutes_14d} vs ${pWant}`);
  const one = (await call('/api/admin/players?scope=all&q=%25')).body;
  check('players: a literal % in the search is not a wildcard', one.total === 0);
  const byEmail = (await call('/api/admin/players?scope=all&q=dee@')).body;
  check('players: search by email', byEmail.total === 1 && byEmail.players[0].id === 'dee');
  const dee = byEmail.players[0];
  check('players: shows the games they are playing', dee.games.length === 1 && dee.games[0].name === 'Pale Harbor');
  const tooBig = (await call('/api/admin/players?scope=all&limit=500')).body;
  check('players: page size is capped under D1\'s 100-parameter limit', tooBig.players.length <= 50);
} finally {
  Date.now = realNow;
}

console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
