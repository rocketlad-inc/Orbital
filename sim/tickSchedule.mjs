// ============================================================
// TICK SPEED BY TIME OF DAY (worker/tickSchedule.js, migration 0171).
//
// Asked for again and again (Moitão, 2026-10-05 / 10-09; Lorne
// 2026-10-18: "30 min ticks from 8am to midnight, and 1hr ticks from
// midnight to 8am"). Checks:
//   1. the clock maths in a zone without daylight saving (Sao Paulo),
//      including the snap: a tick never runs past a period's start;
//   2. a whole day: 8 night ticks + 32 day ticks;
//   3. across a daylight-saving change (New York, 2026-11-01): 08:00
//      is still 08:00 on the players' clocks;
//   4. what the host may save, and what it refuses;
//   5. the REAL host endpoint and the REAL alarm, on a fake clock: ticks
//      land on the schedule, tick_interval_ms follows the speed in force,
//      and a flat Tick Speed pick turns the schedule off.
//
// Run: node sim/tickSchedule.mjs
// ============================================================

import {
  normalizeSchedule, intervalAt, nextTickAt, nextBoundaryAfter, readSchedule,
} from '../worker/tickSchedule.js';

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
};
const H = 3_600_000, M30 = 1_800_000;
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const ALLOWED = new Set([30_000, 60_000, 300_000, M30, H, 2 * H, 6 * H, 12 * H, 24 * H]);

// ---- 1. Sao Paulo (UTC-3 all year) -----------------------------------
const SP = normalizeSchedule({
  tz: 'America/Sao_Paulo',
  periods: [{ at: '08:00', interval_ms: M30 }, { at: '00:00', interval_ms: H }],
}, ALLOWED).schedule;
check('the schedule saves, sorted by start time', SP && SP.periods.map(p => p.at).join() === '00:00,08:00');
const sp = (hhmm, day = 18) => Date.parse(`2026-10-${day}T${hhmm}:00-03:00`);
check('07:00 local is night: an hour a tick', intervalAt(SP, sp('07:00')) === H);
check('12:00 local is day: thirty minutes', intervalAt(SP, sp('12:00')) === M30);
check('23:59 is still day, 00:00 is night', intervalAt(SP, sp('23:59')) === M30 && intervalAt(SP, sp('00:00')) === H);
check('a 07:40 tick is followed by one at 08:00 sharp, not 08:40',
  nextTickAt(SP, sp('07:40')) === sp('08:00'), iso(nextTickAt(SP, sp('07:40'))));
check('...then every thirty minutes', nextTickAt(SP, sp('08:00')) === sp('08:30'));
check('a 23:45 tick is followed by midnight, then hourly',
  nextTickAt(SP, sp('23:45')) === sp('00:00', 19) && nextTickAt(SP, sp('00:00', 19)) === sp('01:00', 19),
  iso(nextTickAt(SP, sp('23:45'))));
check('exactly on a start time, the next start is the other one',
  nextBoundaryAfter(SP, sp('08:00')) === sp('00:00', 19));

// ---- 2. A whole day ---------------------------------------------------
{
  let t = sp('00:00'), n = 0;
  const end = sp('00:00', 19);
  while (t < end) { t = nextTickAt(SP, t); n++; }
  check('one whole day: 8 night ticks + 32 day ticks = 40 (24 at a flat hour)', n === 40 && t === end, `${n}, ends ${iso(t)}`);
}

// ---- 3. Daylight saving: New York falls back 2026-11-01 02:00 ---------
{
  const NY = normalizeSchedule({
    tz: 'America/New_York',
    periods: [{ at: '08:00', interval_ms: M30 }, { at: '00:00', interval_ms: H }],
  }, ALLOWED).schedule;
  const start = Date.parse('2026-10-31T23:00:00-04:00');
  const eight = Date.parse('2026-11-01T08:00:00-05:00');   // EST after the change
  const ticks = [];
  for (let t = start; t <= eight && ticks.length < 40; t = nextTickAt(NY, t)) ticks.push(t);
  check('across the clock change, a tick still lands at 08:00 local (13:00Z)',
    ticks.includes(eight), ticks.map(iso).join(' '));
  // 23:00 and 23:30 EDT are still day; midnight EDT (04:00Z) to 08:00 EST
  // (13:00Z) is nine real hours, so ten hourly ticks counting both ends.
  check('...two day ticks, then hourly through the nine-hour night the clock change makes',
    ticks.map(iso).map(s => s.slice(11, 16)).join() === '03:00,03:30,04:00,05:00,06:00,07:00,08:00,09:00,10:00,11:00,12:00,13:00',
    ticks.map(iso).join(' '));
  const spring = normalizeSchedule({
    tz: 'America/New_York',
    periods: [{ at: '08:00', interval_ms: M30 }, { at: '00:00', interval_ms: H }],
  }, ALLOWED).schedule;
  const s0 = Date.parse('2026-03-08T07:00:00-04:00');
  check('...and in spring (clocks forward), 08:00 EDT too',
    nextTickAt(spring, s0) === Date.parse('2026-03-08T08:00:00-04:00'), iso(nextTickAt(spring, s0)));
}

// ---- 4. What a host may save -------------------------------------------
const refuse = (raw) => !!normalizeSchedule(raw, ALLOWED).error;
check('refused: an unknown time zone', refuse({ tz: 'Mars/Olympus', periods: SP.periods }));
check('refused: one period (that is just a speed)', refuse({ tz: 'UTC', periods: [SP.periods[0]] }));
check('refused: five periods', refuse({ tz: 'UTC', periods: ['00:00', '04:00', '08:00', '12:00', '16:00'].map(at => ({ at, interval_ms: H })) }));
check('refused: two periods starting together', refuse({ tz: 'UTC', periods: [{ at: '08:00', interval_ms: H }, { at: '08:00', interval_ms: M30 }] }));
check('refused: a speed the pills do not offer', refuse({ tz: 'UTC', periods: [{ at: '08:00', interval_ms: 7 }, { at: '00:00', interval_ms: H }] }));
check('refused: a time like 25:00', refuse({ tz: 'UTC', periods: [{ at: '25:00', interval_ms: H }, { at: '00:00', interval_ms: H }] }));
check('stored garbage reads as no schedule', readSchedule('{nope') === null && readSchedule(null) === null);

// ---- 5. The real endpoint and the real alarm ---------------------------
const { SimD1 } = await import('./d1.mjs');
const { MIGRATIONS } = await import('../worker/_migrations_bundle.js');
const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response(null, { status: 204 }) }) } };
const G = 'gsched01';
let clock = sp('07:10');
const realNow = Date.now;
Date.now = () => clock;
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES ('u1','u1@t','u1','x',0)`).run();
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES ('u2','u2@t','u2','x',0)`).run();
await DB.prepare(`INSERT INTO rooms (id,name,host_id,created_at,updated_at) VALUES (?,'Sched','u1',0,0)`).bind(G).run();
await DB.prepare(`INSERT INTO games (id,status,map_seed,current_tick,tick_interval_ms,created_at,started_at) VALUES (?,'setup','sched',0,?,0,0)`).bind(G, H).run();
await DB.prepare(`INSERT INTO room_members (room_id,user_id,joined_at,chosen_starting_body) VALUES (?,'u1',0,'earth')`).bind(G).run();
const factions = await import('../worker/factions.js');
await factions.seedGameWorld(env, G);
await DB.prepare(`UPDATE games SET status='active', next_tick_at = ? WHERE id=?`).bind(sp('07:30'), G).run();

const { routes } = await import('../worker/lobby.js');
const call = async (user, path, body) => {
  for (const r of routes) {
    if (r.method !== 'PATCH') continue;
    const m = path.match(r.pattern);
    if (!m) continue;
    const url = new URL(`https://x${path}`);
    const res = await r.handle(new Request(url, { method: 'PATCH', body: JSON.stringify(body) }), env,
      { url, params: m.groups ?? {}, session: { user_id: user } });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  return { status: 404 };
};
const sched = { tz: 'America/Sao_Paulo', periods: [{ at: '00:00', interval_ms: H }, { at: '08:00', interval_ms: M30 }] };
let r = await call('u2', `/api/lobby/rooms/${G}/tick-schedule`, { schedule: sched });
check('only the host can set it', r.status === 403, JSON.stringify(r.body));
r = await call('u1', `/api/lobby/rooms/${G}/tick-schedule`, { schedule: { ...sched, tz: 'Nowhere/Land' } });
check('a bad schedule is refused with a reason', r.status === 400 && /time zone/.test(r.body?.error?.message ?? ''), JSON.stringify(r.body));
r = await call('u1', `/api/lobby/rooms/${G}/tick-schedule`, { schedule: sched });
check('the host saves it at 07:10 local', r.status === 200, JSON.stringify(r.body));
let g = await DB.prepare('SELECT tick_schedule, tick_interval_ms, next_tick_at FROM games WHERE id = ?').bind(G).first();
check('...saving never delays the tick already due (07:30 stays)', g.next_tick_at === sp('07:30'), iso(g.next_tick_at));
check('...and the speed in force is the night hour', g.tick_interval_ms === H);

const { Room } = await import('../worker/room.js');
const store = new Map([['gameStarted', { gameId: G }]]);
const room = new Room({
  storage: {
    async get(k) { return store.get(k); }, async put(k, v) { store.set(k, v); },
    async delete(k) { return store.delete(k); }, async list() { return new Map(store); },
    async deleteAll() { store.clear(); }, setAlarm() {}, getAlarm() { return null; },
  },
  blockConcurrencyWhile: async (f) => f(),
  getWebSockets: () => [],
  broadcast: () => {},
}, env);
const fired = [];
for (let k = 0; k < 6; k++) {
  g = await DB.prepare('SELECT next_tick_at FROM games WHERE id = ?').bind(G).first();
  clock = g.next_tick_at;
  await room.alarm();
  const after = await DB.prepare('SELECT current_tick, next_tick_at, tick_interval_ms FROM games WHERE id = ?').bind(G).first();
  fired.push({ at: clock, next: after.next_tick_at, speed: after.tick_interval_ms, tick: after.current_tick });
}
const hhmm = (ms) => new Date(ms - 3 * H).toISOString().slice(11, 16);
check('the real alarm: ticks at 07:30, then 08:00 sharp, then every 30 minutes',
  fired.map(f => hhmm(f.at)).join() === '07:30,08:00,08:30,09:00,09:30,10:00',
  fired.map(f => hhmm(f.at)).join());
check('...one tick each time', fired.every((f, i) => f.tick === i + 1), fired.map(f => f.tick).join());
check('...tick_interval_ms follows the speed in force (1h, then 30m)',
  fired[0].speed === H && fired.slice(1).every(f => f.speed === M30), fired.map(f => f.speed / 60000).join());
// Late at night.
clock = sp('23:40');
await DB.prepare('UPDATE games SET next_tick_at = ? WHERE id = ?').bind(sp('23:40'), G).run();
await room.alarm();
g = await DB.prepare('SELECT next_tick_at FROM games WHERE id = ?').bind(G).first();
check('a 23:40 tick schedules midnight (the night speed begins on the dot)', g.next_tick_at === sp('00:00', 19), iso(g.next_tick_at));
clock = g.next_tick_at;
await room.alarm();
g = await DB.prepare('SELECT next_tick_at, tick_interval_ms FROM games WHERE id = ?').bind(G).first();
check('...then 01:00, at an hour a tick', g.next_tick_at === sp('01:00', 19) && g.tick_interval_ms === H, iso(g.next_tick_at));

r = await call('u1', `/api/lobby/rooms/${G}/tick-interval`, { tick_interval_ms: 2 * H });
g = await DB.prepare('SELECT tick_schedule, tick_interval_ms FROM games WHERE id = ?').bind(G).first();
check('picking a flat Tick Speed turns the schedule off', r.status === 200 && g.tick_schedule == null && g.tick_interval_ms === 2 * H,
  JSON.stringify(g));
r = await call('u1', `/api/lobby/rooms/${G}/tick-schedule`, { schedule: sched });
r = await call('u1', `/api/lobby/rooms/${G}/tick-schedule`, { schedule: null });
g = await DB.prepare('SELECT tick_schedule FROM games WHERE id = ?').bind(G).first();
check('...and Turn off clears it', r.status === 200 && g.tick_schedule == null);

Date.now = realNow;
console.log(bad ? `\n${bad} FAILED` : '\nALL TICK SCHEDULE CHECKS PASS');
process.exit(bad ? 1 : 0);
