// ============================================================
// COMMISSION REACH (0153) — gifts, surfaces, the funnel.
//
// The Commission had one paid sale and no record of anything before
// checkout. 0153 adds surface tracking, gifting and a per-surface funnel.
// Two of those touch money, so they get the same treatment as the
// webhook: the real handlers, a real HMAC, and the failure each guard
// exists to stop.
//
//   - a gift purchase mints exactly ONE code (redelivery, both
//     completion events) and grants the buyer nothing
//   - redeeming is all-or-nothing: wrong, unknown, voided and spent
//     codes grant nothing; two accounts racing for one code -> one wins
//   - refunding a gift voids an unredeemed code and takes back a
//     redeemed one, and touches nobody else
//   - checkout: a holder may buy a GIFT but not a second Commission;
//     the surface is checked against an allow-list before it reaches
//     Stripe; every attempt is logged with its outcome
//   - the admin funnel adds those rows up per surface, robots excluded
//
// Run: node sim/commissionReach.mjs
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { handleStripeWebhook, hasEntitlement, routes as storeRoutes, normalizeGiftCode } from '../worker/store.js';
import { routes as analyticsRoutes } from '../worker/analytics.js';
import { routes as dashRoutes } from '../worker/adminDashboard.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

const SECRET = 'whsec_test_secret_do_not_use';
const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = {
  DB, STRIPE_WEBHOOK_SECRET: SECRET,
  STRIPE_SECRET_KEY: 'sk_test_sim', STRIPE_PRICE_COSMETICS: 'price_sim',
};
for (const [id, email] of [['buyer', 'buyer@t'], ['friend', 'friend@t'], ['rival', 'rival@t'],
  ['holder', 'holder@t'], ['bot', 'bot@agents.orbital.local']]) {
  await DB.prepare('INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,?,0)')
    .bind(id, email, id[0].toUpperCase() + id.slice(1), 'x').run();
}
await DB.prepare(`INSERT INTO user_entitlements (user_id, sku, source, granted_at) VALUES ('holder','cosmetics_v1','admin',0)`).run();

const enc = new TextEncoder();
async function sign(body) {
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey('raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${body}`));
  return `t=${t},v1=${[...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('')}`;
}
async function hook(event) {
  const body = JSON.stringify(event);
  const res = await handleStripeWebhook(new Request('https://x/api/stripe/webhook', {
    method: 'POST', body, headers: { 'stripe-signature': await sign(body) },
  }), env);
  return res.status;
}
const paidSession = (id, user, meta, type = 'checkout.session.completed') => ({
  type,
  data: { object: {
    id, client_reference_id: user, payment_status: 'paid', payment_intent: `pi_${id}`,
    metadata: { sku: 'cosmetics_v1', user_id: user, ...meta },
  } },
});
const rows = async (sql, ...a) => (await DB.prepare(sql).bind(...a).all()).results;

function route(list, method, path) {
  for (const r of list) {
    if (r.method !== method) continue;
    if (typeof r.pattern === 'string' ? r.pattern === path : r.pattern.test(path)) return r;
  }
  throw new Error(`no route ${method} ${path}`);
}
async function call(list, method, path, userId, body) {
  const url = new URL(`https://orbital.test${path}`);
  const req = new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const email = (await DB.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first())?.email ?? 'lcfeeser@gmail.com';
  const res = await route(list, method, url.pathname).handle(req, env, { url, session: { user_id: userId, email }, params: {} });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// ---- 1. a gift purchase mints one code and grants the buyer nothing ----
check('a paid GIFT session is accepted', await hook(paidSession('cs_gift1', 'buyer', { gift: '1', surface: 'profile' })) === 200);
await hook(paidSession('cs_gift1', 'buyer', { gift: '1', surface: 'profile' }));
await hook(paidSession('cs_gift1', 'buyer', { gift: '1', surface: 'profile' }, 'checkout.session.async_payment_succeeded'));
let gifts = await rows('SELECT * FROM commission_gifts');
check('...redelivered and on both completion events, it mints exactly one code', gifts.length === 1, JSON.stringify(gifts));
check('...the code is 12 lookalike-free characters', /^[A-HJ-NP-Z2-9]{12}$/.test(gifts[0]?.code ?? ''), gifts[0]?.code);
check('...and the buyer is NOT granted the Commission by buying it for someone else', !(await hasEntitlement(env, 'buyer')));

// ---- 2. a self purchase carries its surface onto the grant -------------
await hook(paidSession('cs_self1', 'rival', { gift: '0', surface: 'endgame' }));
const selfRow = (await rows(`SELECT surface, source FROM user_entitlements WHERE user_id = 'rival'`))[0];
check('a self purchase grants, stamped with the surface that sold it', selfRow?.source === 'stripe' && selfRow?.surface === 'endgame', JSON.stringify(selfRow));
await hook(paidSession('cs_old', 'bot', {}));
check('an old-style session (no surface, no gift flag) still grants, surface NULL',
  (await rows(`SELECT surface FROM user_entitlements WHERE user_id = 'bot'`))[0]?.surface === null);

// ---- 3. redeeming -------------------------------------------------------
const code = gifts[0].code;
const shown = `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`.toLowerCase();
check('codes are read forgivingly (dashes, case, spaces)', normalizeGiftCode(` ${shown} `) === code);
check('a malformed code is refused before any lookup', (await call(storeRoutes, 'POST', '/api/commission/redeem', 'friend', { code: 'nope' })).status === 400);
check('an unknown code is refused', (await call(storeRoutes, 'POST', '/api/commission/redeem', 'friend', { code: 'ABCDEFGHJKLM' })).status === 404);
check('a holder cannot spend a code they do not need', (await call(storeRoutes, 'POST', '/api/commission/redeem', 'holder', { code: shown })).status === 409);
check('...and the code is still unspent', (await rows('SELECT redeemed_by FROM commission_gifts'))[0].redeemed_by === null);

// Two accounts race for one code: the claim and the grant are one batch,
// and the grant only lands for whoever the claim names.
await DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES ('racer','racer@t','Racer','x',0)`).run();
const [a, b] = await Promise.all([
  call(storeRoutes, 'POST', '/api/commission/redeem', 'friend', { code: shown }),
  call(storeRoutes, 'POST', '/api/commission/redeem', 'racer', { code: shown }),
]);
const winners = [await hasEntitlement(env, 'friend'), await hasEntitlement(env, 'racer')].filter(Boolean).length;
check('two accounts racing for one code: exactly one ends up holding it', winners === 1 && [a.status, b.status].sort().join() === '200,409', `${a.status} ${b.status} winners ${winners}`);
const winner = (await hasEntitlement(env, 'friend')) ? 'friend' : 'racer';
const grant = (await rows('SELECT source, surface, gift_code FROM user_entitlements WHERE user_id = ?', winner))[0];
check('...the grant says where it came from', grant?.source === 'gift' && grant?.surface === 'gift' && grant?.gift_code === code, JSON.stringify(grant));
check('a spent code cannot be redeemed again', (await call(storeRoutes, 'POST', '/api/commission/redeem', 'buyer', { code: shown })).status === 409);
check('...by anyone', !(await hasEntitlement(env, 'buyer')));

const listed = await call(storeRoutes, 'GET', '/api/commission/gifts', 'buyer');
check('the buyer sees their code, redeemed, and by whom',
  listed.body.gifts.length === 1 && listed.body.gifts[0].code === shown.toUpperCase()
  && listed.body.gifts[0].redeemed_at != null && listed.body.gifts[0].redeemed_by_name != null, JSON.stringify(listed.body));
check('nobody else sees it', (await call(storeRoutes, 'GET', '/api/commission/gifts', 'rival')).body.gifts.length === 0);

// ---- 4. refunding a gift ------------------------------------------------
await hook(paidSession('cs_gift2', 'buyer', { gift: '1' }));
const code2 = (await rows(`SELECT code FROM commission_gifts WHERE stripe_session_id = 'cs_gift2'`))[0].code;
await hook({ type: 'charge.refunded', data: { object: { payment_intent: 'pi_cs_gift2', refunded: true } } });
check('refunding an UNREDEEMED gift voids its code', (await call(storeRoutes, 'POST', '/api/commission/redeem', 'buyer', { code: code2 })).status === 404);
check('...and grants nothing', !(await hasEntitlement(env, 'buyer')));
await hook({ type: 'charge.refunded', data: { object: { payment_intent: 'pi_cs_gift1', refunded: true } } });
check('refunding a REDEEMED gift takes the Commission back from whoever redeemed it', !(await hasEntitlement(env, winner)));
check('...and leaves every other holder alone',
  (await hasEntitlement(env, 'rival')) && (await hasEntitlement(env, 'holder')) && (await hasEntitlement(env, 'bot')));
await hook(paidSession('cs_gift3', 'buyer', { gift: '1' }));
await hook({ type: 'charge.refunded', data: { object: { payment_intent: 'pi_cs_gift3', refunded: false } } });
check('a PARTIAL refund of a gift voids nothing',
  (await rows(`SELECT voided_at FROM commission_gifts WHERE stripe_session_id = 'cs_gift3'`))[0].voided_at === null);

// ---- 5. checkout ----------------------------------------------------------
const sent = [];
globalThis.fetch = async (u, init) => {
  sent.push(Object.fromEntries(new URLSearchParams(init.body)));
  return new Response(JSON.stringify({ url: 'https://checkout.stripe.com/c/sim' }), { status: 200 });
};
const own = await call(storeRoutes, 'POST', '/api/checkout/cosmetics', 'holder', { surface: 'profile' });
check('a holder cannot buy a second Commission for themselves', own.status === 409 && sent.length === 0);
const giftCheckout = await call(storeRoutes, 'POST', '/api/checkout/cosmetics', 'holder', { surface: 'profile', gift: true });
check('...but CAN buy one as a gift', giftCheckout.status === 200 && sent.at(-1)?.['metadata[gift]'] === '1');
check('...returning to the gift page, not the thank-you for a purchase of their own', sent.at(-1)?.success_url?.endsWith('/?purchase=gift'));
await call(storeRoutes, 'POST', '/api/checkout/cosmetics', 'friend', { surface: 'designer' });
check('a surface on the allow-list reaches Stripe as given', sent.at(-1)?.['metadata[surface]'] === 'designer');
await call(storeRoutes, 'POST', '/api/checkout/cosmetics', 'friend', { surface: '<script>' });
check('anything else reaches Stripe as "other"', sent.at(-1)?.['metadata[surface]'] === 'other');
const legacy = await call(storeRoutes, 'POST', '/api/checkout/cosmetics', 'friend');
check('an old client posting no body still gets a checkout', legacy.status === 200 && sent.at(-1)?.['metadata[gift]'] === '0');
const logged = await rows(`SELECT user_id, status, payload FROM analytics_events WHERE kind = 'commission/checkout' ORDER BY id`);
check('every checkout attempt is logged with its outcome',
  logged.length === 5 && logged[0].status === 409 && JSON.parse(logged[0].payload).result === 'already_owned'
  && logged.filter(r => r.status === 200).length === 4, JSON.stringify(logged));

// ---- 6. surface telemetry and the funnel ---------------------------------
const tel = (user, kind, from) => call(analyticsRoutes, 'POST', '/api/telemetry', user, { kind, payload: { from } });
check('account telemetry (no game) is accepted', (await tel('friend', 'commission-view', 'designer')).status === 204);
await tel('rival', 'commission-view', 'designer');
await tel('friend', 'commission-click', 'designer');
await tel('bot', 'commission-view', 'designer'); // a robot: never counted
await tel('rival', 'commission-dismiss', 'thanks-card');
check('...stored with no game id, kind prefixed ui/',
  (await rows(`SELECT COUNT(*) AS n FROM analytics_events WHERE kind = 'ui/commission-view' AND game_id IS NULL`))[0].n === 3);
const funnel = (await call(dashRoutes, 'GET', '/api/admin/commission', 'admin')).body;
const designer = funnel.surfaces.find(s => s.surface === 'designer');
check('funnel: views and viewers per surface, robots excluded', designer.views === 2 && designer.viewers === 2, JSON.stringify(designer));
check('funnel: clicks and STARTED checkouts per surface (refusals are not checkouts)', designer.clicks === 1 && designer.checkouts === 1);
check('funnel: paid sales per surface, from the grant rows', funnel.surfaces.find(s => s.surface === 'endgame').paid === 1);
check('funnel: dismissals of the one-time card are counted', funnel.surfaces.find(s => s.surface === 'thanks-card').dismissals === 1);
check('funnel: gifts sold, redeemed, voided', funnel.gifts.sold === 3 && funnel.gifts.redeemed === 1 && funnel.gifts.voided === 2, JSON.stringify(funnel.gifts));
check('the funnel is admin-only', (await call(dashRoutes, 'GET', '/api/admin/commission', 'friend')).status === 404);

console.log(bad === 0 ? '\nALL COMMISSION REACH CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
