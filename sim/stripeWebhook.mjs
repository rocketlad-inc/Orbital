// ============================================================
// STRIPE WEBHOOK — the money path, which had no coverage at all.
//
// Everything a player pays for arrives through this one handler, and
// until now nothing exercised it: 10 entitlements exist in production
// and every one was granted by an admin. The first real card would have
// been the first execution.
//
// Drives the REAL handleStripeWebhook against a REAL signature, because
// the two things that can go wrong here are both invisible from the
// outside — a signature check that accepts what it should not, and a
// paid session that grants nothing while Stripe's dashboard shows the
// money as collected.
//
// Run: node sim/stripeWebhook.mjs
// ============================================================

import { SimD1 } from './d1.mjs';
import { MIGRATIONS } from '../worker/_migrations_bundle.js';
import { handleStripeWebhook, hasEntitlement } from '../worker/store.js';

let bad = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) bad++;
}

const SECRET = 'whsec_test_secret_do_not_use';
const DB = new SimD1(':memory:');
DB.applyMigrations(MIGRATIONS);
const env = { DB, STRIPE_WEBHOOK_SECRET: SECRET };

await DB.prepare(
  `INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES ('u1','buyer@t','Buyer','x',0)`).run();
await DB.prepare(
  `INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES ('u2','slow@t','Slow','x',0)`).run();

const enc = new TextEncoder();
/** Sign exactly the way Stripe does, so the verifier is tested against
 *  the real construction rather than against our own idea of it. */
async function sign(body, { secret = SECRET, t = Math.floor(Date.now() / 1000) } = {}) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${body}`));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `t=${t},v1=${hex}`;
}

const post = async (event, sigOpts) => {
  const body = JSON.stringify(event);
  const sig = sigOpts === null ? 'garbage' : await sign(body, sigOpts ?? {});
  const req = new Request('https://x/api/stripe/webhook', {
    method: 'POST', body, headers: { 'stripe-signature': sig },
  });
  const res = await handleStripeWebhook(req, env);
  return { status: res.status, body: await res.json() };
};

const session = (over = {}) => ({
  type: 'checkout.session.completed',
  data: { object: {
    id: 'cs_test_1', client_reference_id: 'u1', payment_status: 'paid',
    payment_intent: 'pi_test_1', metadata: { sku: 'cosmetics_v1', user_id: 'u1' },
    ...over,
  } },
});

// ---- the signature is the only authentication this route has ---------
const forged = await post(session(), null);
check('an unsigned payload is refused', forged.status === 400, JSON.stringify(forged));
check('...and grants nothing', !(await hasEntitlement(env, 'u1')));

const wrongKey = await post(session(), { secret: 'whsec_not_ours' });
check('a payload signed with the wrong secret is refused', wrongKey.status === 400);

// Replay: a payload captured an hour ago, signature still perfectly
// valid, timestamp outside the tolerance.
const stale = await post(session(), { t: Math.floor(Date.now() / 1000) - 3600 });
check('a correctly signed REPLAY outside the window is refused', stale.status === 400);
check('...and still grants nothing', !(await hasEntitlement(env, 'u1')));

// ---- a real card payment grants ---------------------------------------
const paid = await post(session());
check('a signed paid session is accepted', paid.status === 200, JSON.stringify(paid));
check('...and the buyer owns the Commission', await hasEntitlement(env, 'u1'));

// ---- redelivery is free ------------------------------------------------
// Stripe retries until it gets a 2xx, and sends the same session under
// more than one event type. Neither may double-grant or error.
const again = await post(session());
check('redelivery of the same session is accepted', again.status === 200);
const rows = (await DB.prepare(
  `SELECT COUNT(*) AS n FROM user_entitlements WHERE user_id='u1'`).first()).n;
check('...and leaves exactly one entitlement', rows === 1, String(rows));

// ---- THE BUG THIS SIM WAS WRITTEN FOR ---------------------------------
// A delayed method (bank debit, and several wallets Stripe now enables
// by default) completes UNPAID and settles days later. The handler used
// to skip the unpaid session with a comment promising
// async_payment_succeeded would catch it, and nothing handled that
// event: charged, never granted, dashboard showing success.
const pending = await post(session({
  id: 'cs_test_2', client_reference_id: 'u2', payment_status: 'unpaid',
  payment_intent: 'pi_test_2', metadata: { sku: 'cosmetics_v1', user_id: 'u2' },
}));
check('an unpaid session is acknowledged', pending.status === 200);
check('...but grants nothing yet', !(await hasEntitlement(env, 'u2')));

const settled = await post({
  type: 'checkout.session.async_payment_succeeded',
  data: { object: {
    id: 'cs_test_2', client_reference_id: 'u2', payment_status: 'paid',
    payment_intent: 'pi_test_2', metadata: { sku: 'cosmetics_v1', user_id: 'u2' },
  } },
});
check('the delayed payment settling IS handled', settled.status === 200);
check('...and grants the Commission it paid for', await hasEntitlement(env, 'u2'),
  'a bank-debit buyer would be charged and get nothing');

// ---- refunds put it back on the shelf ---------------------------------
const refund = await post({
  type: 'charge.refunded',
  data: { object: { payment_intent: 'pi_test_1', refunded: true } },
});
check('a full refund is accepted', refund.status === 200);
check('...and revokes the entitlement', !(await hasEntitlement(env, 'u1')));
check('...without touching the other buyer', await hasEntitlement(env, 'u2'));

// A PARTIAL refund is not a refund: Stripe sends charge.refunded with
// refunded:false when only some of the amount went back.
await post(session());
const partial = await post({
  type: 'charge.refunded',
  data: { object: { payment_intent: 'pi_test_1', refunded: false } },
});
check('a partial refund does NOT revoke', partial.status === 200 && await hasEntitlement(env, 'u1'));

// ---- an admin grant is not collateral damage ---------------------------
await DB.prepare(
  `INSERT OR IGNORE INTO user_entitlements (user_id, sku, source, granted_by, granted_at)
   VALUES ('u2','cosmetics_v1','admin','lorne@t',0)`).run();
await post({ type: 'charge.refunded', data: { object: { payment_intent: null, refunded: true } } });
check('a refund with no payment intent revokes nothing', await hasEntitlement(env, 'u2'));

// ---- unknown events are acknowledged, not retried ----------------------
const other = await post({ type: 'invoice.paid', data: { object: {} } });
check('an unhandled event type is acknowledged', other.status === 200);

// ---- no secret configured is a refusal, not a silent accept -----------
const noSecret = await handleStripeWebhook(
  new Request('https://x', { method: 'POST', body: '{}' }), { DB });
check('a server with no webhook secret refuses', noSecret.status === 400);

console.log(bad === 0 ? '\nALL STRIPE WEBHOOK CHECKS PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
