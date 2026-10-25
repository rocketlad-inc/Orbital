// ============================================================
// SOLO CLOCK: a paused game never shows a countdown.
//
// Playtest, 2026-10-24 (Leo): spam-clicking Next tick while paused, the
// bar showed "next in 14s" beside the Resume button and "Ticking...".
// Two writes put a next_tick_at on a paused game:
//   1. a Pause pressed WHILE a tick ran: the tick had read the game
//      before the pause and wrote its next_tick_at over the NULL at the end
//   2. a STEP wrote next_tick_at = now for the length of its tick, so
//      every /state polled meanwhile showed a countdown
// Both are on the REAL room tick (worker/room.js) here.
//
// Run: npm run sim:solopause
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}
const alarms = [];
const kv = new Map();
const state = {
  storage: {
    get: async (k) => kv.get(k), put: async (k, v) => { kv.set(k, v); },
    delete: async (k) => kv.delete(k), setAlarm: async (t) => { alarms.push(t); }, getAlarm: async () => null,
  },
  id: { toString: () => 'sim-room' }, acceptWebSocket: () => {}, getWebSockets: () => [],
};
const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = { DB, ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } };
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES ('uH','h@t','Hana','x',0)`).run();

const solo = await import('../worker/solo.js');
const route = solo.routes.find(r => r.pattern === '/api/solo');
const res = await route.handle(new Request('https://x/api/solo', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ rivals: 1, difficulty: 'normal', speed_ms: 30000 }),
}), env, { url: new URL('https://x/api/solo'), params: {}, session: { user_id: 'uH' } });
const G = (await res.json()).game_id;

const { Room } = await import('../worker/room.js');
const r = new Room(state, env);
r.broadcast = () => {};
r.runComputerEmpires = async () => {};
await state.storage.put('gameStarted', { gameId: G, tick_interval_ms: 30000, started_at: 0 });
const real = r.resolveTick.bind(r);
const row = () => DB.prepare('SELECT current_tick, next_tick_at, paused FROM games WHERE id = ?').bind(G).first();

// ---- 1. Pause lands while a tick is running -------------------------------
await DB.prepare('UPDATE games SET paused = 0, next_tick_at = ? WHERE id = ?').bind(Date.now() - 10, G).run();
r.resolveTick = async (gid, t) => {
  await real(gid, t);
  // The player's Pause, mid-tick (solo.js handlePause, verbatim).
  await DB.prepare('UPDATE games SET paused = 1, next_tick_at = NULL, state_version = state_version + 1 WHERE id = ?').bind(G).run();
};
alarms.length = 0;
await r.alarm();
const a = await row();
check('a pause pressed during a tick: the tick still lands', Number(a.current_tick) === 1, JSON.stringify(a));
check('...and the game stays stopped: no next tick', a.next_tick_at == null, JSON.stringify(a));
check('...and no alarm is armed for it', alarms.length === 0, JSON.stringify(alarms));

// ---- 2. Next tick while paused ---------------------------------------------
const seen = [];
r.resolveTick = async (gid, t) => { seen.push((await row()).next_tick_at); await real(gid, t); };
for (let i = 0; i < 3; i++) {
  const resp = await r.fetch(new Request('https://room/tick-now', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ force: true, gameId: G }),
  }));
  if (!resp.ok) check(`step ${i + 1} answered`, false, String(resp.status));
}
const b = await row();
check('three steps while paused advance three ticks', Number(b.current_tick) === 4, JSON.stringify(b));
check('no countdown while a step runs', seen.every(v => v == null), JSON.stringify(seen));
check('still paused, with no next tick', Number(b.paused) === 1 && b.next_tick_at == null, JSON.stringify(b));

console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
