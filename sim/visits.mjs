// ============================================================
// LINK AND AD TRAFFIC (0180) — the visit funnel, through the REAL worker.
//
//   - a tagged landing leaves one anonymous row: tags, ad + keyword,
//     click id, device, in-app browser, country
//   - the same browser landing again bumps the count, never the source
//   - robots are not visitors; junk anon ids and steps are ignored
//   - steps only count for a browser whose landing was counted
//   - signing up joins the browser's row to the new account (once)
//   - the admin overview's "Link and ad traffic" adds it all up
//
// Run: npm run sim:visits
// ============================================================

import worker from '../worker/index.js';
import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { routes as adminRoutes } from '../worker/adminDashboard.js';
import { deviceFrom, inAppFrom } from '../worker/visits.js';

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures++; if (detail !== undefined) console.log(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); }
}

const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
DB.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
for (const m of MIGRATIONS) DB.db.prepare('INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, 0)').run(m.name);
const env = { DB, ROOM: { idFromName: n => n, get: () => ({ fetch: async () => Response.json({ ok: true }) }) }, EMAIL_LINK_SECRET: 'sim' };
const execCtx = { waitUntil() {}, passThroughOnException() {} };

const IPHONE_REDDIT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Reddit/Version 2026.40.0/Build 612345/iOS Version 18.0';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const BOT = 'Mozilla/5.0 (compatible; redditbot/1.0; +http://www.reddit.com/feedback)';

async function call(method, path, { body, cookie, ua = DESKTOP, country } = {}) {
  const headers = { 'content-type': 'application/json', 'user-agent': ua };
  if (cookie) headers.cookie = cookie;
  const req = new Request(`https://orbital-empire.com${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (country) Object.defineProperty(req, 'cf', { value: { country } });
  const res = await worker.fetch(req, env, execCtx);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, data, cookie: setCookie ? setCookie.split(';')[0] : null };
}
const visit = (anon) => DB.prepare('SELECT * FROM campaign_visits WHERE anon_id = ?').bind(anon).first();
const steps = (anon) => DB.prepare('SELECT step FROM campaign_steps WHERE anon_id = ? ORDER BY step').bind(anon).all().then(r => r.results.map(x => x.step));

const ad = { from: 'reddit-ads', utm_campaign: 'kw-4x', utm_content: 'battle-orbit', utm_term: 'Space 4X', click_kind: 'reddit', click_id: 'abc.DEF-123', first_seen_ms: 1, landing: '/' };

// ---- pure helpers ---------------------------------------------------
check('device: iPhone is a phone, Pixel a phone, Windows a desktop, iPad a tablet',
  deviceFrom(IPHONE_REDDIT) === 'phone' && deviceFrom(ANDROID_CHROME) === 'phone' && deviceFrom(DESKTOP) === 'desktop'
  && deviceFrom('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)') === 'tablet');
check('in-app: the Reddit app browser is named; plain Chrome is not', inAppFrom(IPHONE_REDDIT) === 'reddit' && inAppFrom(ANDROID_CHROME) === null);

// ---- landings ---------------------------------------------------------
let r = await call('POST', '/api/visit', { body: { anon: 'anonAAAAAAAA1', step: 'land', a: ad }, ua: IPHONE_REDDIT, country: 'US' });
check('a landing answers 204 with no session', r.status === 204, r);
let v = await visit('anonAAAAAAAA1');
check('...and leaves one row with the tags, the ad, the keyword and the click id',
  v && v.source === 'reddit-ads' && v.campaign === 'kw-4x' && v.content === 'battle-orbit' && v.term === 'space-4x'
  && v.click_kind === 'reddit' && v.click_id === 'abc.DEF-123', v);
check('...the device, the in-app browser and the country', v?.device === 'phone' && v?.in_app === 'reddit' && v?.country === 'US', v);
check('...and no account yet', v?.viewer_user_id === null && v?.signup_user_id === null, v);

await call('POST', '/api/visit', { body: { anon: 'anonAAAAAAAA1', step: 'land', a: { from: 'r-strategygames', first_seen_ms: 2 } } });
v = await visit('anonAAAAAAAA1');
check('the same browser again counts a visit but keeps its first source', v.visits === 2 && v.source === 'reddit-ads', v);

await call('POST', '/api/visit', { body: { anon: 'anonBOTBOTBOT', step: 'land', a: ad }, ua: BOT });
check('a robot is not a visitor', !(await visit('anonBOTBOTBOT')));
await call('POST', '/api/visit', { body: { anon: 'x', step: 'land', a: ad } });
await call('POST', '/api/visit', { body: { anon: 'anon"; DROP', step: 'land', a: ad } });
check('a malformed anon id is ignored', (await DB.prepare('SELECT COUNT(*) AS n FROM campaign_visits').first()).n === 1);
await call('POST', '/api/visit', { body: { anon: 'anonCCCCCCCC3', step: 'land', a: { ...ad, click_kind: 'evil', click_id: 'zzz' } } });
v = await visit('anonCCCCCCCC3');
check('an unknown click network keeps no click id', v && v.click_kind === null && v.click_id === null, v);

// ---- steps ------------------------------------------------------------
for (const s of ['engaged', 'signup_tab', 'email_try', 'engaged', 'bogus']) {
  await call('POST', '/api/visit', { body: { anon: 'anonAAAAAAAA1', step: s } });
}
check('steps count once each, and unknown steps are ignored',
  JSON.stringify(await steps('anonAAAAAAAA1')) === JSON.stringify(['email_try', 'engaged', 'signup_tab']), await steps('anonAAAAAAAA1'));
await call('POST', '/api/visit', { body: { anon: 'anonNEVERLANDED', step: 'engaged' } });
check('a browser that never landed through a link has no funnel', (await steps('anonNEVERLANDED')).length === 0);

// ---- signup joins the funnel to the account ---------------------------
r = await call('POST', '/api/auth/signup', {
  body: { email: 'pat@players.org', password: 'password123', display_name: 'Pat', attribution: { ...ad, anon: 'anonAAAAAAAA1' } },
});
check('signup with the browser id succeeds', r.status === 201, r.data);
const pat = r.data.user.id;
v = await visit('anonAAAAAAAA1');
check('...and the browser row now names the account', v.signup_user_id === pat, v);
const u = await DB.prepare('SELECT signup_source, signup_campaign FROM users WHERE id = ?').bind(pat).first();
check('...while the account keeps its usual source and campaign', u.signup_source === 'reddit-ads' && u.signup_campaign === 'kw-4x', u);
await call('POST', '/api/auth/signup', {
  body: { email: 'sam@players.org', password: 'password123', display_name: 'Sam', attribution: { ...ad, anon: 'anonAAAAAAAA1' } },
});
check('a second account from the same browser does not take the row over', (await visit('anonAAAAAAAA1')).signup_user_id === pat);

// An existing player clicking the ad while signed in.
await call('POST', '/api/visit', { body: { anon: 'anonPLAYERPLAY', step: 'land', a: ad }, cookie: r.cookie });
check('a signed-in player who clicks is marked as already a player', (await visit('anonPLAYERPLAY')).viewer_user_id !== null);

// A bounce and a Google failure from an organic post.
await call('POST', '/api/visit', { body: { anon: 'anonDDDDDDDD4', step: 'land', a: { from: 'r-pbbg', first_seen_ms: 3 } }, ua: ANDROID_CHROME });
await call('POST', '/api/visit', { body: { anon: 'anonDDDDDDDD4', step: 'google_error' } });

// ---- the admin overview -------------------------------------------------
const overview = adminRoutes.find(x => x.pattern === '/api/admin/overview');
const res = await overview.handle(new Request('https://x/api/admin/overview'), env,
  { url: new URL('https://x/api/admin/overview'), session: { user_id: 'admin', email: 'lcfeeser@gmail.com' }, params: {} });
const ov = await res.json();
const tr = ov.traffic;
check('the overview has a traffic block', !!tr && Array.isArray(tr.campaigns), Object.keys(ov));
const row = tr?.campaigns.find(x => x.source === 'reddit-ads' && x.campaign === 'kw-4x');
check('reddit-ads / kw-4x: 3 visitors, 1 engaged, 1 started, 1 signed up, 1 already a player, 1 on a phone, 2 ad clicks',
  row && row.visitors === 3 && row.engaged === 1 && row.started === 1 && row.signed_up === 1 && row.players === 1 && row.phones === 1 && row.clicks === 2, row);
const adRow = tr?.ads.find(x => x.content === 'battle-orbit' && x.term === 'space-4x');
check('the ad and keyword get their own row', adRow && adRow.visitors === 3 && adRow.signed_up === 1, adRow);
const pbbg = tr?.campaigns.find(x => x.source === 'r-pbbg');
check('r-pbbg: one visitor, one error (the Google button), no signup', pbbg && pbbg.visitors === 1 && pbbg.errors === 1 && pbbg.signed_up === 0, pbbg);
const redditApp = tr?.devices.find(x => x.device === 'phone' && x.in_app === 'reddit');
check('the Reddit app browser shows in the device table', redditApp?.visitors === 1, tr?.devices);
check('countries and the 14-day series are filled', tr?.countries.some(c => c.country === 'US') && tr?.daily.length > 0, tr?.countries);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
