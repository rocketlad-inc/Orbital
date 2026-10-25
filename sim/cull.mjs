// ============================================================
// The idle cull (worker/cull.js): a game with no PLAYER action for 15 days
// is ended, a lobby nobody touched for 15 days is closed. No email, ever.
//
// Drives the real sweep over SimD1 with the real analytics rollup
// (adminDashboard.rollupAnalytics fills analytics_game_seen), a recording
// Room DO, a recording EMAIL binding and a recording fetch (Discord / push).
//
//   * the cutoff to the hour: 14d23h is safe, 15d1h is ended
//   * a recent human event vetoes a stale rollup; so does a late human join
//   * no_cull, the showcase id and Studio test games are never touched
//   * bots and agents never keep a game alive (and a person does)
//   * a game with no analytics row: new = safe, old = culled 15d from start
//   * unsaved trial accounts (shadow) are people
//   * ending is idempotent, tells the Room DO once, writes one chronicle row
//   * NO email (sendGameOver, the Herald email), no awards, no Herald post,
//     no push/Discord traffic; one feed line where the feed is on (EN + pt)
//   * the ending page for an abandoned game has no winner and no awards
//   * lobbies: 14d safe, 16d closed, a recent join or a started game safe
//   * staging skips; the hourly claim runs once; the cap defers the rest;
//     dryRun writes nothing; the kill switch stops it; operator routes 404
//
// Run: npm run sim:cull
// ============================================================

import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';
import * as mail from '../worker/email.js';
import * as cull from '../worker/cull.js';
import { rollupAnalytics } from '../worker/adminDashboard.js';
import { buildEnding, recordGameAwards } from '../worker/ending.js';
import { buildProfileAwards } from '../worker/profileAwards.js';
import { maybeRunDailyDigest } from '../worker/digest.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { checkShape } from './endingShape.mjs';

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures++; if (detail !== undefined) console.log(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); }
}
const eq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR + 17 * 60_000;   // 17 minutes into an hour
const ago = (ms) => NOW - ms;

// ---- fakes -----------------------------------------------------------------

const sent = [];
const EMAIL = { async send(msg) { sent.push(msg); return { messageId: `m${sent.length}` }; } };

const doCalls = [];
const doAll = [];
const ROOM = {
  idFromName: (name) => name,
  get: (id) => ({
    async fetch(url, init) {
      const path = new URL(typeof url === 'string' ? url : url.url).pathname;
      doCalls.push({ id, path, body: init?.body });
      doAll.push({ id, path, body: init?.body });
      if (path === '/settings') return Response.json({});
      return new Response(null, { status: 204 });
    },
  }),
};

const realFetch = globalThis.fetch;
const outbound = [];
globalThis.fetch = async (url, init) => {
  const u = String(typeof url === 'string' ? url : url?.url);
  outbound.push({ url: u, method: init?.method ?? 'GET', body: init?.body });
  return new Response(JSON.stringify({ id: 'msg1' }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const realError = console.error;
const errors = [];
console.error = (...a) => { errors.push(a.map(String).join(' ')); };

const SIM = new SimD1(':memory:');
SIM.applyMigrations(MIGRATIONS);
SIM.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
for (const m of MIGRATIONS) SIM.db.prepare('INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, 0)').run(m.name);
SIM.db.exec('PRAGMA foreign_keys = OFF');   // a read-model fixture: no body/ship scaffolding

// A spy over the database: every write statement is recorded.
let writes = [];
const DB = {
  prepare(sql) {
    const st = SIM.prepare(sql);
    if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql)) {
      const bind = st.bind.bind(st);
      st.bind = (...a) => { const b = bind(...a); b._write = sql; return b; };
    }
    return st;
  },
  async batch(stmts) {
    for (const s of stmts) if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(s._sql)) writes.push(s._sql);
    return SIM.batch(stmts);
  },
};
// (single .run() writes are counted by wrapping run on the statement class)
{
  const proto = Object.getPrototypeOf(SIM.prepare('SELECT 1'));
  const run = proto.run;
  proto.run = function (...a) { if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(this._sql)) writes.push(this._sql); return run.apply(this, a); };
}
const env = { DB, ROOM, EMAIL, EMAIL_LINK_SECRET: 'sim-secret', AGENT_KEY: 'sim-agent-key' };
const execCtx = { waitUntil() {}, passThroughOnException() {} };

const q = (sql, ...a) => SIM.prepare(sql).bind(...a);
const all = async (sql, ...a) => (await q(sql, ...a).all()).results;
const one = async (sql, ...a) => q(sql, ...a).first();
const count = async (table, where = '1=1', ...a) => (await one(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...a)).n;
function ins(table, row) {
  const cols = Object.keys(row);
  return SIM.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .bind(...cols.map(c => row[c])).run();
}
const statusOf = async (id) => (await one('SELECT status, victory_type, winner_faction_id, completed_at, next_tick_at FROM games WHERE id = ?', id));
const roomStatus = async (id) => (await one('SELECT status FROM rooms WHERE id = ?', id)).status;

// ---- users -------------------------------------------------------------------

const U = {};
async function user(key, email, locale = null) {
  U[key] = `usr_${key}`;
  await ins('users', { id: U[key], email, display_name: key, password_hash: 'x', created_at: 0, locale });
}
await user('alice', 'alice@gmail.com');
await user('bob', 'bob@gmail.com');
await user('carl', 'carl@gmail.com');
await user('dora', 'dora@gmail.com', 'pt-BR');
await user('bot1', 'agent+solo-ai-1@agents.orbital.local');
await user('bot2', 'agent+qa-probe@agents.orbital.local');
await user('shadow1', 'trial-abc@shadow.orbital.local');
await user('qa1', 'harness@example.com');

let eid = 0;
const event = (gameId, who, kind, ms) => ins('analytics_events', { game_id: gameId, user_id: U[who], kind, created_at_ms: ms });

/** A running game: a room, a games row, and its seats. */
async function game(id, {
  started = ago(40 * DAY), status = 'active', noCull = 0, test = 0, solo = 0, trial = 0,
  seats = ['alice'], bots = [], name = `Game ${id}`, host = 'alice', victory = null, tick = 500,
} = {}) {
  await ins('rooms', { id, name, host_id: U[host], status: 'in_progress', max_players: 4, created_at: started, updated_at: started });
  await ins('games', {
    id, status, map_seed: 's', created_at: started, started_at: started, tick_interval_ms: HOUR, current_tick: tick,
    next_tick_at: NOW + HOUR, no_cull: noCull, is_test_game: test, solo, trial, victory_type: victory,
    completed_at: status === 'completed' ? ago(1 * DAY) : null,
  });
  let slot = 0;
  for (const s of seats) {
    await ins('game_factions', { id: `${id}:${s}`, game_id: id, user_id: U[s], slot: slot++, name: `${s} of ${id}`, color: '#112233', joined_at: started, status: 'active', metal: 0, gold: 0, science: 0 });
    await ins('room_members', { room_id: id, user_id: U[s], joined_at: started });
  }
  for (const b of bots) {
    await ins('game_factions', { id: `${id}:${b}`, game_id: id, user_id: U[b], slot: slot++, name: `${b} of ${id}`, color: '#445566', joined_at: started, status: 'active', metal: 0, gold: 0, science: 0, ai_doctrine: 'rusher' });
  }
}
/** A lobby: a room with no game yet. */
async function lobby(id, { updated, created = updated, members = [], joined = created, status = 'lobby', quick = 0, max = 4 } = {}) {
  await ins('rooms', { id, name: `Lobby ${id}`, host_id: U.alice, status, max_players: max, created_at: created, updated_at: updated, quick_join: quick });
  for (const m of members) await ins('room_members', { room_id: id, user_id: U[m], joined_at: joined });
}
/** What the rollup (cron) has folded in, as it would have by now. */
async function rollup() {
  for (let i = 0; i < 60; i++) {
    const r = await rollupAnalytics(env, NOW);
    if (r.passes < 5) break;
  }
}

// ============================================================================
// SEED
// ============================================================================
// -- the cutoff to the hour
await game('G14', {});                              await event('G14', 'alice', 'POST ships/orders', ago(14 * DAY + 23 * HOUR));
await game('G15', {});                              await event('G15', 'alice', 'POST ships/orders', ago(15 * DAY + 1 * HOUR));
// -- a recent raw event the rollup has not seen (inside its 2-minute lag) vetoes a stale rollup
await game('GVETO', {});                            await event('GVETO', 'alice', 'POST ships/orders', ago(20 * DAY));
// -- never culled
await game('GNOCULL', { noCull: 1 });               await event('GNOCULL', 'alice', 'POST x', ago(30 * DAY));
await game('Kai68RfB5BhV', { noCull: 0 });          await event('Kai68RfB5BhV', 'alice', 'POST x', ago(30 * DAY));   // the column unset: the code constant still holds
await game('GTEST', { test: 1 });                   await event('GTEST', 'alice', 'POST x', ago(30 * DAY));
// -- bots: the person idle 16 days, the computer empires acted yesterday
await game('GBOTS', { bots: ['bot1', 'bot2'] });    await event('GBOTS', 'alice', 'POST ships/orders', ago(16 * DAY));
for (let i = 0; i < 20; i++) await event('GBOTS', 'bot1', 'POST ships/orders', ago(1 * DAY + i * 1000));
await event('GBOTS', 'bot2', 'POST research', ago(2 * HOUR));
await event('GBOTS', 'qa1', 'POST research', ago(3 * HOUR));
// -- the same game with a person acting two days ago
await game('GBOTSHUMAN', { bots: ['bot1'] });       await event('GBOTSHUMAN', 'alice', 'POST ships/orders', ago(16 * DAY));
await event('GBOTSHUMAN', 'bob', 'POST ships/orders', ago(2 * DAY));
// -- watching is not acting: heartbeats and perf chatter do not keep a game alive
await game('GWATCH', {});                           await event('GWATCH', 'alice', 'POST ships/orders', ago(18 * DAY));
for (let i = 0; i < 30; i++) await event('GWATCH', 'alice', 'heartbeat', ago(i * HOUR));
await event('GWATCH', 'alice', 'POST perf', ago(1 * HOUR));
// -- no analytics rows at all
await game('GNEW', { started: ago(1 * DAY) });
await game('GNOEVENTS14', { started: ago(14 * DAY) });
await game('GNOEVENTS16', { started: ago(16 * DAY) });
// -- unsaved trial players are people
await game('GSHADOW', { seats: ['shadow1'], bots: ['bot1'], host: 'shadow1', trial: 1, solo: 1 });
await event('GSHADOW', 'shadow1', 'POST ships/orders', ago(3 * DAY));
await game('GSHADOWOLD', { seats: ['shadow1'], bots: ['bot1'], host: 'shadow1', trial: 1, solo: 1, started: ago(25 * DAY) });
await event('GSHADOWOLD', 'shadow1', 'POST ships/orders', ago(20 * DAY));
// -- a person who joined the game two days ago has not acted yet
await game('GJOINED', { seats: ['alice'] });        await event('GJOINED', 'alice', 'POST ships/orders', ago(20 * DAY));
await ins('game_factions', { id: 'GJOINED:carl', game_id: 'GJOINED', user_id: U.carl, slot: 5, name: 'Carl late', color: '#abcdef', joined_at: ago(2 * DAY), status: 'active', metal: 0, gold: 0, science: 0 });
// -- all-computer game (no person at all)
await game('GALLBOT', { seats: [], bots: ['bot1', 'bot2'] });
// -- already over
await game('GDONE', { status: 'completed', victory: 'domination' });   await event('GDONE', 'alice', 'POST x', ago(40 * DAY));

await rollup();
// The veto case: the rollup says 20 days; a human acted a moment ago, inside the rollup's lag.
await event('GVETO', 'bob', 'POST ships/orders', ago(60_000));

// -- lobbies
await lobby('LBY_14', { updated: ago(14 * DAY), created: ago(20 * DAY), members: ['alice', 'bob'], joined: ago(20 * DAY) });
await lobby('LBY_16', { updated: ago(16 * DAY), created: ago(20 * DAY), members: ['alice'], joined: ago(20 * DAY) });
await lobby('LBY_JOIN', { updated: ago(20 * DAY), created: ago(20 * DAY), members: ['alice'], joined: ago(20 * DAY) });
await ins('room_members', { room_id: 'LBY_JOIN', user_id: U.bob, joined_at: ago(1 * DAY) });
await lobby('LBY_FULL', { updated: ago(30 * DAY), members: ['alice', 'bob', 'carl', 'dora'], max: 4 });
await lobby('LBY_QUICK', { updated: ago(21 * DAY), members: ['alice'], quick: 1, max: 5 });
await lobby('LBY_EMPTY', { updated: ago(40 * DAY), members: [] });
await lobby('LBY_WITHGAME', { updated: ago(40 * DAY), members: ['alice'] });   // status 'lobby' but a game row exists: not a lobby
await ins('games', { id: 'LBY_WITHGAME', status: 'active', map_seed: 's', created_at: ago(1 * DAY), started_at: ago(1 * DAY), tick_interval_ms: HOUR });
await lobby('LBY_CLOSED', { updated: ago(40 * DAY), members: ['alice'], status: 'closed' });

// ============================================================================
// SELECTION
// ============================================================================
console.log('\n-- selection');
{
  const games = await cull.findIdleGames(env, NOW);
  const ids = new Set(games.map(g => g.id));
  check('14d23h since the last human action: NOT idle', !ids.has('G14'));
  check('15d1h since the last human action: idle', ids.has('G15'));
  check('a recent human event vetoes a stale rollup', !ids.has('GVETO'),
    { rollup: await one('SELECT last_action_ms FROM analytics_game_seen WHERE game_id = ?', 'GVETO') });
  check('no_cull = 1 is never idle', !ids.has('GNOCULL'));
  check('the showcase game id is never idle, even with the column unset', !ids.has('Kai68RfB5BhV'));
  check('a Studio test game is never idle', !ids.has('GTEST'));
  check('bots and agents acting yesterday do NOT keep a game alive', ids.has('GBOTS'));
  check('a person acting two days ago does (bots beside them)', !ids.has('GBOTSHUMAN'));
  check('heartbeats and perf chatter are not actions', ids.has('GWATCH'));
  check('a brand-new game with no analytics row is safe', !ids.has('GNEW'));
  check('a game started 14d ago with no row is safe', !ids.has('GNOEVENTS14'));
  check('a game started 16d ago with no row is idle (15d from its start)', ids.has('GNOEVENTS16'));
  check('an unsaved trial player acting 3 days ago keeps the game alive', !ids.has('GSHADOW'));
  check('an unsaved trial player idle 20d: idle', ids.has('GSHADOWOLD'));
  check('a person who joined 2 days ago keeps the game alive', !ids.has('GJOINED'));
  check('an all-computer game is idle 15d after it started', ids.has('GALLBOT'));
  check('a finished game is not considered', !ids.has('GDONE'));
  const g15 = games.find(g => g.id === 'G15');
  check('the report carries humans, the last action and the days idle', g15.humans === 1 && g15.idleDays === 15 && /no player action since/.test(g15.reason), g15);
  const bots = games.find(g => g.id === 'GBOTS');
  check('humans counts people only (bots beside one person)', bots.humans === 1, bots);
  eq('the idle set is exactly the expected games', [...ids].sort(), ['G15', 'GALLBOT', 'GBOTS', 'GNOEVENTS16', 'GSHADOWOLD', 'GWATCH']);

  const lobs = await cull.findIdleLobbies(env, NOW);
  const lids = new Set(lobs.map(l => l.id));
  check('a lobby idle 14d is not idle', !lids.has('LBY_14'));
  check('a lobby idle 16d is idle', lids.has('LBY_16'));
  check('a lobby with a member who joined yesterday is not idle', !lids.has('LBY_JOIN'));
  check('a full lobby is judged like any other (idle 30d: idle)', lids.has('LBY_FULL'));
  check('a Quick Join lobby follows the same rule', lids.has('LBY_QUICK'));
  check('an empty lobby idle 40d is idle', lids.has('LBY_EMPTY'));
  check('a room with a game row is not a lobby', !lids.has('LBY_WITHGAME'));
  check('an already-closed room is not selected again', !lids.has('LBY_CLOSED'));
  eq('the idle lobbies are exactly the expected ones', [...lids].sort(), ['LBY_EMPTY', 'LBY_FULL', 'LBY_QUICK', 'LBY_16'].sort());
}

// Time moves on in the sweep sections below (up to three hours); keep the
// one game that sits 1h from the cutoff safe by having its player act.
await event('G14', 'alice', 'POST ships/orders', NOW - 5 * 60_000);

// ============================================================================
// DRY RUN: reports, writes nothing
// ============================================================================
console.log('\n-- dry run');
{
  writes = []; doCalls.length = 0;
  const before = await all('SELECT id, status FROM games ORDER BY id');
  const d = await cull.sweepIdle(env, NOW, { dryRun: true });
  check('dryRun lists the games and lobbies', d.dryRun === true && d.games.length === 6 && d.lobbies.length === 4, { g: d.games.length, l: d.lobbies.length });
  eq('dryRun wrote nothing', writes, []);
  eq('dryRun told no Room DO anything', doCalls, []);
  eq('dryRun changed no game', await all('SELECT id, status FROM games ORDER BY id'), before);
  check('dryRun claimed no hourly slot', (await count('cull_runs')) === 0);
}

// ============================================================================
// THE SWEEP
// ============================================================================
console.log('\n-- staging, kill switch');
{
  const st = await cull.sweepIdle({ ...env, ORBITAL_ENV: 'staging' }, NOW);
  check('staging skips entirely', st.ran === false && st.reason === 'staging', st);
  check('...and touched nothing', (await statusOf('G15')).status === 'active' && (await count('cull_runs')) === 0);

  await ins('bot_settings', { key: 'cull_enabled', value: 'false', updated_ms: NOW });
  cull._resetCullSlot();
  const off = await cull.sweepIdle(env, NOW);
  check('the kill switch stops the sweep', off.ran === false && off.reason === 'disabled', off);
  check('...nothing was ended', (await statusOf('G15')).status === 'active' && (await roomStatus('LBY_16')) === 'lobby');
  const dd = await cull.sweepIdle(env, NOW, { dryRun: true });
  check('...and the dry run still works while it is off', dd.dryRun === true && dd.games.length === 6 && dd.enabled === false);
  await SIM.prepare('DELETE FROM bot_settings WHERE key = ?').bind('cull_enabled').run();
  cull._resetCullSlot();
}

console.log('\n-- the hourly claim and the per-run cap');
{
  cull._resetCullSlot();
  doCalls.length = 0;
  // Two crons at once, with a cap of 2 games: the claim lets one of them work.
  const [a, b] = await Promise.all([
    cull.sweepIdle(env, NOW, { maxGames: 2, maxLobbies: 3 }),
    cull.sweepIdle(env, NOW, { maxGames: 2, maxLobbies: 3 }),
  ]);
  const ran = [a, b].filter(r => r.ran);
  check('two concurrent invocations: exactly one runs', ran.length === 1, [a, b]);
  check('...the other is told it was claimed or handled', [a, b].some(r => r.ran === false && /claimed|handled/.test(r.reason)), [a, b]);
  const r = ran[0];
  check('the cap: 2 games ended, 3 lobbies closed', r.gamesEnded === 2 && r.lobbiesClosed === 3, r);
  check('the rest is left for the next hour (4 games, 1 lobby)', r.gamesLeft === 4 && r.lobbiesLeft === 1, r);
  const run = await one('SELECT * FROM cull_runs');
  check('the run is recorded', run.slot_ms === Math.floor(NOW / HOUR) * HOUR && run.games_ended === 2 && run.lobbies_closed === 3 && run.finished_ms != null, run);
  // A cold isolate in the same hour: still claimed.
  cull._resetCullSlot();
  const again = await cull.sweepIdle(env, NOW + 5 * 60_000, { maxGames: 2 });
  check('a cold isolate in the same hour does not run it again', again.ran === false && again.reason === 'claimed', again);
  check('...so still only 2 ended', (await count('games', "victory_type = 'abandoned'")) === 2);

  // The next hours finish the job (2 + 2 more games, the last lobby).
  cull._resetCullSlot();
  const h2 = await cull.sweepIdle(env, NOW + HOUR, { maxGames: 2, maxLobbies: 3 });
  check('next hour: 2 more games, the last lobby', h2.ran && h2.gamesEnded === 2 && h2.lobbiesClosed === 1 && h2.gamesLeft === 2, h2);
  cull._resetCullSlot();
  const h3 = await cull.sweepIdle(env, NOW + 2 * HOUR, { maxGames: 2, maxLobbies: 3 });
  check('the hour after: the last 2 games, nothing left', h3.ran && h3.gamesEnded === 2 && h3.gamesLeft === 0 && h3.lobbiesLeft === 0, h3);
  cull._resetCullSlot();
  const h4 = await cull.sweepIdle(env, NOW + 3 * HOUR);
  check('then it has nothing to do', h4.ran && h4.gamesEnded === 0 && h4.lobbiesClosed === 0, h4);
}

// ============================================================================
// WHAT ENDING A GAME DOES
// ============================================================================
console.log('\n-- ending a game');
{
  for (const id of ['G15', 'GBOTS', 'GWATCH', 'GNOEVENTS16', 'GSHADOWOLD', 'GALLBOT']) {
    const g = await statusOf(id);
    check(`${id} ended: completed / abandoned / no winner / dated / clock cleared`,
      g.status === 'completed' && g.victory_type === 'abandoned' && g.winner_faction_id == null && g.completed_at >= NOW && g.next_tick_at == null, g);
  }
  for (const id of ['G14', 'GVETO', 'GNOCULL', 'Kai68RfB5BhV', 'GTEST', 'GBOTSHUMAN', 'GNEW', 'GNOEVENTS14', 'GSHADOW', 'GJOINED']) {
    check(`${id} still running`, (await statusOf(id)).status === 'active');
  }
  eq('GDONE (a real victory) is untouched', (await statusOf('GDONE')).victory_type, 'domination');

  const told = doCalls.filter(c => c.path === '/abandon');
  eq('the Room DO was told once per ended game', told.map(c => c.id).sort(), ['G15', 'GALLBOT', 'GBOTS', 'GNOEVENTS16', 'GSHADOWOLD', 'GWATCH']);
  check('...with the tick it ended on', JSON.parse(told[0].body).tick === 500);
  eq('one chronicle row per ended game, kind game_abandoned, no free text',
    (await all("SELECT game_id, kind, payload, visibility FROM chronicle_entries WHERE kind = 'game_abandoned' ORDER BY game_id")).map(r => [r.game_id, r.payload, r.visibility]),
    ['G15', 'GALLBOT', 'GBOTS', 'GNOEVENTS16', 'GSHADOWOLD', 'GWATCH'].map(id => [id, '{"reason":"idle","days":15}', 'public']));
  const log = await all("SELECT * FROM cull_log WHERE kind = 'game' ORDER BY id");
  check('the audit trail has a row per game with its last activity and reason',
    log.length === 6 && log.every(r => r.culled_ms >= NOW && r.last_activity_ms > 0 && /no player action since/.test(r.reason)), log);

  // Idempotent.
  doCalls.length = 0;
  const again = await cull.abandonGame(env, 'G15', { nowMs: NOW + 99 });
  check('ending an already-ended game is a no-op', again.ended === false);
  eq('...tells the Room DO nothing', doCalls, []);
  check('...writes no second chronicle row or log row',
    (await count('chronicle_entries', "game_id = 'G15' AND kind = 'game_abandoned'")) === 1 && (await count('cull_log', "id = 'G15'")) === 1);
  const real = await cull.abandonGame(env, 'GDONE');
  check('a game that really finished is not re-ended', real.ended === false && (await statusOf('GDONE')).victory_type === 'domination');
  const nc = await cull.abandonGame(env, 'GNOCULL');
  check('abandonGame itself refuses a no_cull game', nc.ended === false && (await statusOf('GNOCULL')).status === 'active');
  // The guard: a human acts between selection and the write.
  await event('G14', 'alice', 'POST x', NOW - 1000);
  const raced = await cull.abandonGame(env, 'G14', { nowMs: NOW, cutoffMs: NOW - cull.CULL_AFTER_MS });
  check('a human action that lands before the write saves the game', raced.ended === false && (await statusOf('G14')).status === 'active');
}

// ============================================================================
// SIDE EFFECTS THAT MUST NOT HAPPEN
// ============================================================================
console.log('\n-- no email, no awards, no Herald, no push');
{
  eq('no email was sent by the whole sweep', sent.map(m => m.subject), []);
  check('no push, Discord or other outbound request from ending games', !outbound.some(o => /discord|push|fcm|googleapis|webpush/i.test(o.url)), outbound.map(o => o.url));
  await mail.sendGameOver(env, 'G15');
  eq('sendGameOver on an ended game sends nothing', sent.map(m => m.subject), []);
  check('...and logs no email row', (await count('email_log')) === 0);

  // The Herald email: a control game (active, news, a reader) is attempted; the ended game is not.
  await ins('chronicle_entries', { id: 'ctl1', game_id: 'G14', tick_number: 5, kind: 'ship_built', actor_faction_id: 'G14:alice', payload: '{}', visibility: 'public', created_at_ms: NOW - 3600_000 });
  await ins('chronicle_entries', { id: 'ab1', game_id: 'GBOTS', tick_number: 5, kind: 'ship_built', actor_faction_id: 'GBOTS:alice', payload: '{}', visibility: 'public', created_at_ms: NOW - 3600_000 });
  errors.length = 0; sent.length = 0;
  const h = await mail.maybeSendDailyHeraldEmails(env, NOW, { force: true });
  const attempted = (id) => sent.some(m => (m.html ?? '').includes(id) || (m.text ?? '').includes(id)) || errors.some(e => e.includes(`for ${id}`));
  check('the Herald email still considers the running control game', attempted('G14') || h.sent > 0, { h, errors });
  check('...but never the ended one', !attempted('GBOTS'), { sent: sent.length, errors });

  // The Discord Herald (digest): a spy over chronicle reads per game.
  const bound = [];
  const spyDB = { ...DB, prepare(sql) {
    const st = DB.prepare(sql);
    const bind = st.bind.bind(st);
    st.bind = (...a) => { if (/chronicle_entries|digest_state/.test(sql)) bound.push(a.join('|')); return bind(...a); };
    return st;
  } };
  // Both games have their Discord feed on, so without the guard the ended
  // game WOULD get a final edition.
  await ins('game_feeds', { game_id: 'G14', level: 'all', thread_id: 'T20', updated_ms: 0 });
  await ins('game_feeds', { game_id: 'GBOTS', level: 'all', thread_id: 'T21', updated_ms: 0 });
  outbound.length = 0;
  const etHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date()) ) % 24;
  await ins('bot_settings', { key: 'herald_hour_eastern', value: String(etHour), updated_ms: NOW });
  await maybeRunDailyDigest({ ...env, DB: spyDB, DISCORD_BOT_TOKEN: 'tok', DISCORD_DIGEST_WEBHOOK: 'https://discord.test/hook' }).catch(() => {});
  check('the Discord Herald looked at the running control game', bound.some(b => b.includes('G14')), bound);
  check('...and never at the ended game (no final edition)', !bound.some(b => b.includes('GBOTS')) && !outbound.some(o => o.url.includes('/T21/')), { bound, out: outbound.map(o => o.url) });
  await SIM.prepare('DELETE FROM bot_settings WHERE key = ?').bind('herald_hour_eastern').run();

  check('no player was messaged (messages / notification log empty)',
    (await count('notification_log').catch(() => 0)) === 0);
}

// ============================================================================
// AWARDS AND THE ENDING PAGE
// ============================================================================
console.log('\n-- awards and the ending page');
{
  // Give two games the same stats: a real victory and an abandoned one.
  async function stats(id) {
    await ins('game_factions', { id: `${id}:ai`, game_id: id, user_id: null, slot: 7, name: 'The Machines', color: '#000000', joined_at: 0, status: 'active', metal: 0, gold: 0, science: 0 });
    for (let i = 0; i < 3; i++) await ins('chronicle_entries', { id: `${id}:sb${i}`, game_id: id, tick_number: i + 1, kind: 'ship_built', actor_faction_id: `${id}:alice`, payload: '{}', created_at_ms: 0 });
    await ins('game_settlements', { id: `${id}:st1`, game_id: id, body_id: `${id}:b1`, owner_faction_id: `${id}:alice`, type: 'city', name: 'x', hp: 10, hp_max: 10, created_at_tick: 0 });
  }
  await stats('GBOTS');
  await game('GREAL', { status: 'completed', victory: 'domination' });
  await SIM.prepare('UPDATE games SET winner_faction_id = ? WHERE id = ?').bind('GREAL:alice', 'GREAL').run();
  await stats('GREAL');

  const real = await buildEnding(env, 'GREAL', U.alice);
  check('control: a real victory stores awards when opened', (await count('game_awards', "game_id = 'GREAL'")) > 0 && real.awards.length > 0, { n: real.awards.length });

  const ab = await buildEnding(env, 'GBOTS', U.alice);
  check('the ending of an abandoned game builds (no winner)', !ab.error && ab.game.victoryType === 'abandoned' && ab.game.winnerFactionId == null, ab.error ?? ab.game);
  check('...with the standings', ab.factions.length >= 2 && ab.factions.every(f => f.isWinner === false), ab.factions?.map(f => f.isWinner));
  eq('...and no superlatives', ab.awards, []);
  check('...no victory moment names a winner', ab.timeline.filter(m => m.kind === 'victory').every(m => m.factionIds.length === 0), ab.timeline);
  const CONTRACT = readFileSync('src/multiplayer/endingTypes.ts', 'utf8');
  const shape = checkShape(ab, CONTRACT, 'EndingPayload');
  check('...and still matches the EndingPayload contract', shape.length === 0, shape);
  check('no award rows or awards marker stored for it', (await count('game_awards', "game_id = 'GBOTS'")) === 0 && (await count('game_awards_state', "game_id = 'GBOTS'")) === 0);
  const rec = await recordGameAwards(env, 'GBOTS');
  check('recordGameAwards refuses an abandoned game', rec.computed === false && rec.stored === 0 && (await count('game_awards', "game_id = 'GBOTS'")) === 0, rec);
  const prof = await buildProfileAwards(env, U.alice);
  check('the profile does not backfill an abandoned game (not pending, no rows)',
    (await count('game_awards', "game_id = 'GBOTS'")) === 0 && !prof.awards.some(a => a.gameId === 'GBOTS'), prof.pending);
}

// ============================================================================
// THE FEED LINE
// ============================================================================
console.log('\n-- the one outward effect: a feed line');
{
  await game('GFEED', { started: ago(30 * DAY), name: 'Feed Game' });
  await game('GFEEDPT', { started: ago(30 * DAY), name: 'Jogo Feed', host: 'dora', seats: ['dora'] });
  await game('GFEEDOFF', { started: ago(30 * DAY), name: 'Quiet Game' });
  const fenv = { ...env, DISCORD_BOT_TOKEN: 'tok' };
  await ins('game_feeds', { game_id: 'GFEED', level: 'headlines', thread_id: 'T1', updated_ms: 0 });
  await ins('game_feeds', { game_id: 'GFEEDPT', level: 'all', thread_id: 'T2', updated_ms: 0 });
  await ins('game_feeds', { game_id: 'GFEEDOFF', level: 'off', thread_id: 'T3', updated_ms: 0 });
  outbound.length = 0; sent.length = 0;
  for (const id of ['GFEED', 'GFEEDPT', 'GFEEDOFF']) await cull.abandonGame(fenv, id, { nowMs: NOW });
  const posts = outbound.filter(o => /\/channels\/T\d\/messages$/.test(o.url));
  eq('exactly the feeds that are on got a post', posts.map(p => p.url.split('/').slice(-2)[0]).sort(), ['T1', 'T2']);
  const body = (t) => JSON.parse(posts.find(p => p.url.includes(`/${t}/`)).body).content;
  check('English feed: short, names the game, says 15 days', /Feed Game/.test(body('T1')) && /15 days/.test(body('T1')), body('T1'));
  check('Portuguese feed (host locale pt-BR)', /Jogo Feed/.test(body('T2')) && /15 dias/.test(body('T2')), body('T2'));
  eq('...and still no email', sent.map(m => m.subject), []);
}

// ============================================================================
// LOBBIES
// ============================================================================
console.log('\n-- closing lobbies');
{
  for (const id of ['LBY_16', 'LBY_FULL', 'LBY_QUICK', 'LBY_EMPTY']) check(`${id} closed`, (await roomStatus(id)) === 'closed');
  for (const id of ['LBY_14', 'LBY_JOIN']) check(`${id} still open`, (await roomStatus(id)) === 'lobby');
  check('a started room is not treated as a lobby', (await roomStatus('LBY_WITHGAME')) === 'lobby' && (await statusOf('LBY_WITHGAME')).status === 'active');
  const told = doAll.filter(c => c.path === '/close-idle').map(c => c.id).sort();
  eq('the Room DO was told once per closed lobby', told, ['LBY_16', 'LBY_EMPTY', 'LBY_FULL', 'LBY_QUICK'].sort());
  eq('closing a lobby deletes nothing: its members are still seated', await count('room_members', "room_id = 'LBY_16'"), 1);
  eq('the audit trail names the lobbies', (await all("SELECT id FROM cull_log WHERE kind = 'lobby' ORDER BY id")).map(r => r.id), ['LBY_16', 'LBY_EMPTY', 'LBY_FULL', 'LBY_QUICK'].sort());
  doCalls.length = 0;
  const r = await cull.closeLobby(env, 'LBY_16');
  check('closing a closed lobby is a no-op', r.closed === false && doCalls.length === 0);
  // A join moves updated_at between selection and the close: the close is skipped.
  await lobby('LBY_RACE', { updated: ago(20 * DAY), members: ['alice'] });
  const seen = ago(20 * DAY);
  await SIM.prepare('UPDATE rooms SET updated_at = ? WHERE id = ?').bind(NOW - 1000, 'LBY_RACE').run();
  const race = await cull.closeLobby(env, 'LBY_RACE', { nowMs: NOW, seenUpdatedAt: seen });
  check('a join between selection and the close saves the lobby', race.closed === false && (await roomStatus('LBY_RACE')) === 'lobby');
}

console.log('\n-- what a player sees');
{
  const call = async (path, { method = 'GET', key } = {}) => {
    const headers = {};
    if (key) headers['x-agent-key'] = key;
    const res = await worker.fetch(new Request(`https://orbital-empire.com${path}`, { method, headers }), env, execCtx);
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  // My Games (the real handler): a signed-in session for alice.
  await ins('sessions', { token: 'tok-alice', user_id: U.alice, created_at: NOW, expires_at: NOW + DAY });
  const mine = await worker.fetch(new Request('https://orbital-empire.com/api/lobby/mine', { headers: { cookie: 'orbital_session=tok-alice' } }), env, execCtx);
  const m = await mine.json().catch(() => null);
  if (!m?.games) {
    check('My Games answers', false, { status: mine.status, body: m });
  } else {
    const by = Object.fromEntries(m.games.map(g => [g.id, g]));
    check('My Games lists a closed lobby, finished, labelled closed (idle), not joinable', by.LBY_16?.phase === 'finished' && by.LBY_16.closed === 'idle' && by.LBY_16.joinable === false && by.LBY_16.is_member === true, by.LBY_16);
    check('...its closed time is updated_at', by.LBY_16?.updated_at >= NOW);
    check('My Games lists an ended game as finished with no winner and abandoned set', by.G15?.phase === 'finished' && by.G15.abandoned === true && by.G15.winner == null && by.G15.completed_at >= NOW, by.G15);
    check('a running lobby is not marked closed', by.LBY_14?.closed === null && by.LBY_14.phase !== 'finished', by.LBY_14);
    check('a Studio-style closed room (no cull_log row) stays hidden', !by.LBY_CLOSED);
  }
  const browse = await worker.fetch(new Request('https://orbital-empire.com/api/lobby/browse', { headers: { cookie: 'orbital_session=tok-alice' } }), env, execCtx);
  const b = await browse.json();
  check('Browse shows neither a closed lobby nor an abandoned game', !b.games.some(g => g.id === 'LBY_16' || g.id === 'G15'), b.games.map(g => g.id));
  const joinClosed = await worker.fetch(new Request('https://orbital-empire.com/api/rooms/LBY_16/join', {
    method: 'POST', headers: { cookie: 'orbital_session=tok-alice', 'content-type': 'application/json' }, body: '{}',
  }), env, execCtx);
  const jc = await joinClosed.json();
  check('a closed lobby cannot be joined (room_closed)', joinClosed.status === 409 && jc.error?.code === 'room_closed', jc);
  const ws = await worker.fetch(new Request('https://orbital-empire.com/api/rooms/LBY_16/ws', { headers: { cookie: 'orbital_session=tok-alice', upgrade: 'websocket' } }), env, execCtx);
  check('...nor entered over its socket', ws.status === 409, ws.status);
  const snap = await worker.fetch(new Request('https://orbital-empire.com/api/rooms/LBY_16', { headers: { cookie: 'orbital_session=tok-alice' } }), env, execCtx);
  check('...nor read', snap.status === 409, snap.status);

  console.log('\n-- operator routes');
  for (const p of ['dry-run', 'status']) {
    check(`/api/internal/cull/${p} without the key is a 404`, (await call(`/api/internal/cull/${p}`)).status === 404);
    check(`/api/internal/cull/${p} with a wrong key is a 404`, (await call(`/api/internal/cull/${p}`, { key: 'nope' })).status === 404);
  }
  check('a POST is a 404 even with the key', (await call('/api/internal/cull/dry-run', { method: 'POST', key: 'sim-agent-key' })).status === 404);
  writes = [];
  const dr = await call('/api/internal/cull/dry-run', { key: 'sim-agent-key' });
  check('dry-run with the key lists what would go (and writes nothing)',
    dr.status === 200 && Array.isArray(dr.data.games) && Array.isArray(dr.data.lobbies) && dr.data.dryRun === true && writes.length === 0, { s: dr.status, w: writes.length });
  const stt = await call('/api/internal/cull/status', { key: 'sim-agent-key' });
  check('status shows the kill switch, the last run and the totals',
    stt.status === 200 && stt.data.enabled === true && stt.data.lastRun?.games_ended >= 0 && stt.data.totals.some(t => t.kind === 'game' && t.n >= 6), stt.data);
}

// ============================================================================
// THE CRON: the minute handler runs the sweep (and a failing sweep breaks nothing)
// ============================================================================
console.log('\n-- the minute cron');
{
  const sim2 = new SimD1(':memory:');
  sim2.applyMigrations(MIGRATIONS);
  sim2.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  for (const m of MIGRATIONS) sim2.db.prepare('INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, 0)').run(m.name);
  sim2.db.exec('PRAGMA foreign_keys = OFF');
  const t = Date.now();
  const run2 = (sql, ...a) => sim2.prepare(sql).bind(...a).run();
  await run2("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ('u1', 'x@gmail.com', 'x', 'x', 0)");
  await run2("INSERT INTO rooms (id, name, host_id, status, max_players, created_at, updated_at) VALUES ('cronGame', 'Cron Game', 'u1', 'in_progress', 4, ?, ?)", t - 40 * DAY, t - 40 * DAY);
  await run2("INSERT INTO games (id, status, map_seed, created_at, started_at, tick_interval_ms, current_tick) VALUES ('cronGame', 'active', 's', ?, ?, 3600000, 9)", t - 40 * DAY, t - 40 * DAY);
  await run2("INSERT INTO rooms (id, name, host_id, status, max_players, created_at, updated_at) VALUES ('cronLobby', 'Cron Lobby', 'u1', 'lobby', 4, ?, ?)", t - 40 * DAY, t - 40 * DAY);
  const calls = [];
  const env2 = { DB: sim2, ROOM: { idFromName: (n) => n, get: (id) => ({ async fetch(u) { calls.push([id, new URL(u).pathname]); return new Response(null, { status: 204 }); } }) } };
  cull._resetCullSlot();
  const tasks = [];
  await worker.scheduled({}, env2, { waitUntil: (p) => tasks.push(p) });
  await Promise.all(tasks);
  const g = await sim2.prepare("SELECT status, victory_type FROM games WHERE id = 'cronGame'").first();
  const r = await sim2.prepare("SELECT status FROM rooms WHERE id = 'cronLobby'").first();
  check('the minute cron ended the idle game and closed the idle lobby', g.status === 'completed' && g.victory_type === 'abandoned' && r.status === 'closed', { g, r });
  check('...and told both Room DOs', calls.some(c => c[0] === 'cronGame' && c[1] === '/abandon') && calls.some(c => c[0] === 'cronLobby' && c[1] === '/close-idle'), calls);
  const tasks2 = [];
  await worker.scheduled({}, env2, { waitUntil: (p) => tasks2.push(p) });
  await Promise.all(tasks2);
  check('the next minute does not run it again (one claim per hour)', (await sim2.prepare('SELECT COUNT(*) AS n FROM cull_runs').first()).n === 1);
}

// ---- done ---------------------------------------------------------------------
globalThis.fetch = realFetch;
console.error = realError;
const stray = errors.filter(e => !/herald email compose failed|digest|composeHerald/i.test(e));
if (stray.length) console.log(`(worker logged ${stray.length} error line(s) while running; first: ${stray[0].slice(0, 160)})`);
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
