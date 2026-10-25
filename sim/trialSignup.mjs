// ============================================================
// TRIAL GAME -> SIGNUP, on the admin dashboard, through the REAL worker
// (Lorne, 2026-10-25: "confirm signups through the trial game count").
//
// One browser lands from a tagged link, presses Try out a Solo Game,
// plays, and saves the trial by making an account. A second browser
// saves its trial into an account it already had. The admin overview
// must show, for that link:
//   Trial game  2   (both started one)
//   Signed up   1   (only the NEW account is a signup)
//   Took a seat 1   (the saved trial game is that account's seat)
// and the Trial Game panel must show both trials saved, with how.
//
// Run: npm run sim:trial-signup
// ============================================================

import worker from '../worker/index.js';
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
const execCtx = { waitUntil() {}, passThroughOnException() {} };

async function call(method, path, { body, cookie, ip = '1.2.3.4' } = {}) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': ip, 'user-agent': 'Mozilla/5.0 (sim browser)' };
  if (cookie) headers.cookie = cookie;
  const res = await worker.fetch(new Request(`https://orbital-empire.com${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), env, execCtx);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, data, cookie: setCookie ? setCookie.split(';')[0] : null };
}

const SOURCE = 'r-simgaming';
const attribution = (anon) => ({ from: SOURCE, first_seen_ms: Date.now(), landing: '/', anon });

/** A browser lands from the link, presses Try out a Solo Game, gets a trial. */
async function trialFrom(anon, ip) {
  await call('POST', '/api/visit', { body: { anon, step: 'land', a: { from: SOURCE, landing: '/' } } });
  await call('POST', '/api/visit', { body: { anon, step: 'trial_click' } });
  const t = await call('POST', '/api/trial', { ip, body: { attribution: attribution(anon), lang: 'en' } });
  check(`${anon}: the trial starts`, t.status === 201 && !!t.data.game_id, t);
  return { cookie: t.cookie, gameId: t.data.game_id, shadowId: t.data.user.id };
}

// ---- 1. a new account saves its trial ---------------------------------
const a = await trialFrom('simAnonNew01', '10.0.0.1');
let v = await DB.prepare('SELECT trial_user_id, signup_user_id FROM campaign_visits WHERE anon_id = ?').bind('simAnonNew01').first();
check('before saving: the visit is a trial, not a signup', v?.trial_user_id === a.shadowId && v?.signup_user_id == null, v);

const made = await call('POST', '/api/auth/signup', {
  cookie: a.cookie,
  body: { email: 'newpilot@players.org', password: 'password123', display_name: 'NewPilot', attribution: attribution('simAnonNew01') },
});
check('saving by making an account works', made.status === 201, made);
const newId = made.data?.user?.id;
v = await DB.prepare('SELECT trial_user_id, signup_user_id FROM campaign_visits WHERE anon_id = ?').bind('simAnonNew01').first();
check('after saving: the same visit names the new account as its signup', v?.signup_user_id === newId && v?.trial_user_id === a.shadowId, v);
const seat = await DB.prepare('SELECT COUNT(*) AS n FROM game_factions WHERE game_id = ? AND user_id = ?').bind(a.gameId, newId).first();
check('...and the trial game is that account\'s seat', seat.n === 1, seat);

// ---- 2. an existing account saves another trial -----------------------
const old = await call('POST', '/api/auth/signup', {
  body: { email: 'veteran@players.org', password: 'password123', display_name: 'Veteran' },
});
// Made long before this trial (a fresh one reads as "new" for five minutes).
await DB.prepare('UPDATE users SET created_at = ? WHERE id = ?').bind(Date.now() - 86_400_000, old.data.user.id).run();
const b = await trialFrom('simAnonOld01', '10.0.0.2');
const login = await call('POST', '/api/auth/login', {
  cookie: b.cookie, body: { email: 'veteran@players.org', password: 'password123' },
});
check('saving into an existing account works', login.status === 200, login);
v = await DB.prepare('SELECT trial_user_id, signup_user_id FROM campaign_visits WHERE anon_id = ?').bind('simAnonOld01').first();
check('...and is not counted as a new signup', v?.trial_user_id === b.shadowId && v?.signup_user_id == null, v);

// ---- 3. the dashboard ---------------------------------------------------
const admin = await call('POST', '/api/auth/signup', {
  body: { email: 'lcfeeser@gmail.com', password: 'password123', display_name: 'Admin' },
});
const ov = await call('GET', '/api/admin/overview', { cookie: admin.cookie });
check('the admin overview answers', ov.status === 200, ov.status);
const row = ov.data?.traffic?.campaigns?.find(r => r.source === SOURCE);
check('traffic: Trial game counts both trials', row?.tried === 2, row);
check('traffic: Signed up counts the trial saved into a new account', row?.signed_up === 1, row);
check('traffic: Took a seat counts it too (the saved trial game)', row?.seated === 1, row);
const daily = (ov.data?.traffic?.daily ?? []).filter(r => r.source === SOURCE);
check('the per-source chart has the same numbers', daily.reduce((s, r) => s + r.tried, 0) === 2 && daily.reduce((s, r) => s + r.signed_up, 0) === 1, daily);
const games = ov.data?.trial?.games ?? [];
const ga = games.find(g => g.id === a.gameId), gb = games.find(g => g.id === b.gameId);
check('Trial Game panel: the first trial is saved, by email sign-up, into a new account',
  ga?.shadow === 2 && ga?.saved_how === 'signup' && ga?.saved_into === 'new', ga);
check('Trial Game panel: the second is saved by signing in, into an existing account',
  gb?.shadow === 2 && gb?.saved_how === 'login' && gb?.saved_into === 'existing', gb);
check('Trial Game panel: both trials keep their source', ga?.source === SOURCE && gb?.source === SOURCE, { ga: ga?.source, gb: gb?.source });
const signedUp = await DB.prepare(`SELECT signup_source FROM users WHERE id = ?`).bind(newId).first();
check('the new account carries the link\'s source', signedUp?.signup_source === SOURCE, signedUp);
void old;

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
