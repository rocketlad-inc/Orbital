// ============================================================
// A TRIAL'S CLOCK STOPS WHEN ITS PLAYER LEAVES, through the REAL worker.
//
// The Oct 23-24 traffic report: a trial kept ticking for ~15 minutes
// after its player left (the idle sweep's wait), so 2 of the first 3
// trials reached tick 30 after 2 to 5 minutes of play. Now:
//   - closing the page (pagehide -> POST /trial-leave) pauses it at once;
//   - the next /state (a reload, coming back) wakes it, with no wait;
//   - a player's own pause, and another browser's trial, are left alone;
//   - the idle sweep catches the rest after 3 minutes, not 15;
//   - a SAVED trial is an ordinary solo game: saving wakes it, and the
//     sweep never pauses it again.
//
// Run: npm run sim:trial-leave
// ============================================================

import worker from '../worker/index.js';
import * as trial from '../worker/trial.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures++; if (detail !== undefined) console.log(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); }
}

const ROOM = {
  idFromName: (name) => name,
  get: () => ({ async fetch() { return Response.json({ ok: true }); } }),
};
const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
DB.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
for (const m of MIGRATIONS) DB.db.prepare('INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, 0)').run(m.name);
const env = { DB, ROOM, EMAIL_LINK_SECRET: 'sim-secret' };
// waitUntil work (the /state touch) is awaited before a call returns, as
// it would have finished by the player's next poll.
let pending = [];
const execCtx = { waitUntil(p) { pending.push(p); }, passThroughOnException() {} };

async function call(method, path, { body, cookie, ip = '1.2.3.4' } = {}) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': ip, 'user-agent': 'Mozilla/5.0 (sim browser)' };
  if (cookie) headers.cookie = cookie;
  const res = await worker.fetch(new Request(`https://orbital-empire.com${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), env, execCtx);
  const text = await res.text();
  await Promise.allSettled(pending); pending = [];
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, data, cookie: setCookie ? setCookie.split(';')[0] : null };
}
const game = (id) => DB.prepare('SELECT paused, auto_paused, next_tick_at FROM games WHERE id = ?').bind(id).first();
const running = (g) => g.paused === 0 && g.auto_paused === 0 && g.next_tick_at != null;
const autoPaused = (g) => g.paused === 1 && g.auto_paused === 1 && g.next_tick_at == null;

async function startTrial(ip) {
  const t = await call('POST', '/api/trial', { ip, body: { lang: 'en' } });
  check(`a trial starts (${ip})`, t.status === 201 && !!t.data.game_id, t);
  // The tutorial's last step starts the clock.
  await DB.prepare('UPDATE games SET paused = 0, next_tick_at = ?, host_seen_ms = ? WHERE id = ?').bind(Date.now() + 30_000, Date.now(), t.data.game_id).run();
  return { cookie: t.cookie, gameId: t.data.game_id };
}

// ---- 1. closing the page pauses, coming back wakes ------------------------
const a = await startTrial('10.0.0.1');
const b = await startTrial('10.0.0.2');
await call('GET', `/api/games/${a.gameId}/state`, { cookie: a.cookie }); // playing: last_seen is fresh
const left = await call('POST', `/api/games/${a.gameId}/trial-leave`, { cookie: a.cookie });
check('closing the page answers ok', left.status === 200 && left.data?.paused === true, left);
check('...and the trial pauses at once', autoPaused(await game(a.gameId)), await game(a.gameId));
check('another browser\'s trial keeps running', running(await game(b.gameId)), await game(b.gameId));

await call('GET', `/api/games/${a.gameId}/state`, { cookie: a.cookie });
check('the next /state (a reload) wakes it, without the once-a-minute wait', running(await game(a.gameId)), await game(a.gameId));

// ---- 2. only your own trial, and never your own pause ---------------------
const foreign = await call('POST', `/api/games/${b.gameId}/trial-leave`, { cookie: a.cookie });
check('one trial player cannot pause another\'s trial', foreign.data?.paused === false && running(await game(b.gameId)), { foreign, g: await game(b.gameId) });

await DB.prepare('UPDATE games SET paused = 1, auto_paused = 0, next_tick_at = NULL WHERE id = ?').bind(b.gameId).run();
await call('POST', `/api/games/${b.gameId}/trial-leave`, { cookie: b.cookie });
await call('GET', `/api/games/${b.gameId}/state`, { cookie: b.cookie });
const bp = await game(b.gameId);
check('a pause the player chose stays theirs through a leave and a return', bp.paused === 1 && bp.auto_paused === 0, bp);
const noCookie = await call('POST', `/api/games/${b.gameId}/trial-leave`);
check('with no session it is refused', noCookie.status === 401, noCookie.status);

// ---- 3. the idle sweep: 3 minutes, not 15 ---------------------------------
await DB.prepare('UPDATE games SET paused = 0, auto_paused = 0, next_tick_at = ?, host_seen_ms = ? WHERE id = ?').bind(Date.now() + 30_000, Date.now() - 90_000, a.gameId).run();
await trial.sweepIdleTrials(env);
check('a trial whose player was seen 90 s ago keeps running', running(await game(a.gameId)), await game(a.gameId));
await DB.prepare('UPDATE games SET host_seen_ms = ? WHERE id = ?').bind(Date.now() - 4 * 60_000, a.gameId).run();
await trial.sweepIdleTrials(env);
check('a trial nobody has seen for 4 minutes pauses', autoPaused(await game(a.gameId)), await game(a.gameId));

// ---- 4. a saved trial is an ordinary solo game ----------------------------
const made = await call('POST', '/api/auth/signup', {
  cookie: a.cookie,
  body: { email: 'leaver@players.org', password: 'password123', display_name: 'Leaver' },
});
check('saving the paused trial works', made.status === 201, made);
check('...and saving wakes it', running(await game(a.gameId)), await game(a.gameId));
await DB.prepare('UPDATE games SET host_seen_ms = ? WHERE id = ?').bind(Date.now() - 60 * 60_000, a.gameId).run();
await trial.sweepIdleTrials(env);
check('the idle sweep never pauses a saved trial', running(await game(a.gameId)), await game(a.gameId));
const savedLeave = await call('POST', `/api/games/${a.gameId}/trial-leave`, { cookie: made.cookie });
check('nor does closing the page once it is saved', savedLeave.data?.paused === false && running(await game(a.gameId)), { savedLeave, g: await game(a.gameId) });

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
