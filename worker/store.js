// ============================================================
// store.js — the $10 cosmetics purchase (migration 0078).
//
// Money flow: plain Stripe Checkout, NOT Connect. Orbital is the only
// seller, so there is no marketplace to route payouts through — Stripe
// deposits to the linked bank on its own schedule and this file never
// touches a card number or a payout. The worker's whole job is:
//
//   1. POST /api/checkout/cosmetics  -> mint a Checkout Session, send
//      the player to Stripe's hosted page.
//   2. POST /api/stripe/webhook      -> verify the signature, and on
//      checkout.session.completed grant the entitlement; on
//      charge.refunded revoke it.
//   3. Admin override                -> grant/revoke by email, audited.
//
// WHAT AN ENTITLEMENT GATES. Cosmetics only — premium ship icon
// variants and flag emblems. The validators in index.js (icon_variant)
// and emblems.js (normalizeEmblem) consult hasEntitlement() before
// accepting a premium id; nothing else ever reads this table. If a
// future sku wants to gate anything the simulation can feel, the answer
// is no.
//
// SECRETS (wrangler secret put): STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.
// CONFIG (var or secret):        STRIPE_PRICE_COSMETICS (price_... id).
// All three absent -> every route 400s not_configured, same convention
// as DISCORD_BOT_TOKEN. The game runs fine unmonetized.
// ============================================================

import { isAdminSession } from './admins.js';

const enc = new TextEncoder();

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}
function err(status, code, message) {
  return json({ error: { code, message } }, { status });
}

// The launch catalog is one sku. New products = new entries here, no
// schema change. Values are what checkout mints and what validators ask
// hasEntitlement() about — they are API surface, never rename one.
export const SKUS = {
  cosmetics_v1: {
    priceEnv: 'STRIPE_PRICE_COSMETICS',
    label: 'Commander’s Commission',
  },
};

// Ship icon variants: A-I free, J-S premium (mirror of PREMIUM_VARIANTS
// in src/components/ShipIcons.tsx — same keep-in-sync arrangement as
// emblems). One validator for every save path so the rule can't drift
// between the build queue, the designer and the account template store.
const ICON_VARIANT_RE = /^[A-S]$/;
const PREMIUM_ICON_VARIANTS = new Set(['J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S']);

/**
 * Validate a player-supplied icon variant. Returns null when acceptable,
 * else { code, message } for the caller to wrap in its own err() helper
 * (premium_required should map to 403, the rest to 400). Free letters
 * never touch the database; premium letters cost one indexed PK lookup.
 */
export async function validateIconVariant(env, userId, v) {
  if (typeof v !== 'string' || !ICON_VARIANT_RE.test(v)) {
    return { code: 'bad_request', message: 'invalid icon_variant' };
  }
  if (PREMIUM_ICON_VARIANTS.has(v) && !(await hasEntitlement(env, userId))) {
    return { code: 'premium_required', message: 'that icon line needs the Commander\u2019s Commission' };
  }
  return null;
}

/** Same question for a flag emblem pick. */
export async function validateEmblemChoice(env, userId, emblemId, isPremiumFn) {
  if (isPremiumFn(emblemId) && !(await hasEntitlement(env, userId))) {
    return { code: 'premium_required', message: 'that emblem needs the Commander\u2019s Commission' };
  }
  return null;
}

/** The one question the rest of the codebase asks this module. */
export async function hasEntitlement(env, userId, sku = 'cosmetics_v1') {
  if (!userId) return false;
  const row = await env.DB
    .prepare('SELECT 1 AS x FROM user_entitlements WHERE user_id = ? AND sku = ?')
    .bind(userId, sku)
    .first();
  return !!row;
}

// 404, not 403: probing for admin endpoints should learn nothing. Same
// stance as analytics.js requireAdmin — and now literally the same list,
// imported from admins.js. It was duplicated here; a duplicated
// allow-list fails in the direction that matters, an operator removed
// from one copy keeping access through the other.
function requireAdmin(session) {
  if (!isAdminSession(session)) {
    return err(404, 'not_found', 'no such route');
  }
  return null;
}

// ---------------------------------------------------------------- checkout

async function handleCreateCheckout(req, env, { url, session }) {
  const sku = 'cosmetics_v1';
  const priceId = env[SKUS[sku].priceEnv];
  if (!env.STRIPE_SECRET_KEY || !priceId) {
    return err(400, 'not_configured', 'purchases are not enabled on this server');
  }
  // Repurchase guard — Stripe would happily charge twice; we would grant
  // once (PK collision) and owe a refund. Cheaper to refuse here.
  if (await hasEntitlement(env, session.user_id, sku)) {
    return err(409, 'already_owned', 'this account already owns the Commission');
  }

  // Success/cancel land back on the SPA. origin comes from the request
  // so dev/preview deployments round-trip to themselves.
  const origin = `${url.protocol}//${url.host}`;
  const form = new URLSearchParams({
    mode: 'payment',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    // client_reference_id is the join key the webhook grants against.
    // The user id, not the email — emails can change (0073 renames).
    client_reference_id: session.user_id,
    'metadata[sku]': sku,
    'metadata[user_id]': session.user_id,
    customer_email: session.email,
    success_url: `${origin}/?purchase=success`,
    cancel_url: `${origin}/?purchase=cancelled`,
  });

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });
  const data = await res.json();
  if (!res.ok || !data?.url) {
    // Stripe's message is for our logs; the player gets a generic line.
    console.error('stripe checkout create failed', data?.error?.message ?? res.status);
    return err(502, 'stripe_error', 'could not start checkout — try again in a minute');
  }
  return json({ url: data.url });
}

// ---------------------------------------------------------------- webhook

/**
 * Verify a Stripe-Signature header against the raw body.
 *
 * Format: "t=<unix>,v1=<hmac>[,v1=...]" — multiple v1 entries are legal
 * during secret rotation. HMAC-SHA256 over `${t}.${rawBody}` with the
 * webhook secret. The 5-minute tolerance bounds replay of a captured
 * payload; Stripe's own SDK uses the same default.
 */
async function verifyStripeSignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.create(null);
  for (const kv of header.split(',')) {
    const i = kv.indexOf('=');
    if (i < 0) continue;
    const k = kv.slice(0, i).trim();
    const v = kv.slice(i + 1).trim();
    if (k === 'v1') (parts.v1 ??= []).push(v);
    else parts[k] = v;
  }
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > 300) return false;
  if (!parts.v1?.length) return false;

  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${parts.t}.${rawBody}`));
  const expected = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  // Constant-time compare. XOR-accumulate instead of === so a timing
  // oracle can't binary-search the digest byte by byte.
  return parts.v1.some(sig => {
    if (sig.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  });
}

export async function handleStripeWebhook(req, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return err(400, 'not_configured', 'webhook secret not set');
  }
  const raw = await req.text();
  const ok = await verifyStripeSignature(
    raw, req.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET,
  );
  // 400 (not 401) on a bad signature: Stripe retries 4xx a few times
  // then gives up and surfaces it on the dashboard, which is exactly
  // where a misconfigured secret should become visible.
  if (!ok) return err(400, 'bad_signature', 'signature verification failed');

  let event;
  try { event = JSON.parse(raw); } catch { return err(400, 'bad_request', 'invalid JSON'); }
  const obj = event?.data?.object ?? {};

  if (event.type === 'checkout.session.completed') {
    const userId = obj.client_reference_id;
    const sku = obj.metadata?.sku ?? 'cosmetics_v1';
    // async payment methods (bank debits) complete with payment_status
    // still 'unpaid'; those grant later via async_payment_succeeded.
    if (obj.payment_status !== 'paid') return json({ received: true });
    if (!userId || !SKUS[sku]) {
      console.error('webhook: paid session with no grantable target', obj.id);
      return json({ received: true });
    }
    // INSERT OR IGNORE twice over: the (user, sku) PK absorbs an admin
    // grant already existing; the session-id UNIQUE absorbs redelivery.
    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO user_entitlements
           (user_id, sku, source, stripe_session_id, stripe_payment_intent, granted_at)
         VALUES (?, ?, 'stripe', ?, ?, ?)`,
      )
      .bind(userId, sku, obj.id ?? null, obj.payment_intent ?? null, Date.now())
      .run();
    return json({ received: true });
  }

  if (event.type === 'charge.refunded') {
    // Full refund -> the Commission goes back on the shelf. Keyed by
    // payment intent because that's what a charge carries; admin grants
    // have no intent and are unaffected by definition.
    const intent = obj.payment_intent;
    if (intent && obj.refunded === true) {
      await env.DB
        .prepare('DELETE FROM user_entitlements WHERE stripe_payment_intent = ?')
        .bind(intent)
        .run();
    }
    return json({ received: true });
  }

  // Every other event type: acknowledged and ignored. Stripe sends
  // whatever the dashboard's endpoint config subscribes to; being loud
  // about unhandled types just fills the retry queue.
  return json({ received: true });
}

// ---------------------------------------------------------------- admin

/** Look up a user by email for the override endpoints. */
async function userByEmail(env, email) {
  if (typeof email !== 'string' || !email.includes('@')) return null;
  return env.DB
    .prepare('SELECT id, email, display_name FROM users WHERE LOWER(email) = LOWER(?)')
    .bind(email.trim())
    .first();
}

async function handleAdminGrant(req, env, { session }) {
  const denied = requireAdmin(session);
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  const sku = body?.sku ?? 'cosmetics_v1';
  if (!SKUS[sku]) return err(400, 'bad_request', 'unknown sku');
  const user = await userByEmail(env, body?.email);
  if (!user) return err(404, 'no_such_user', 'no account with that email');

  // OR IGNORE: granting to someone who already owns it (bought it, or a
  // second admin got there first) is a no-op, not an error — the goal
  // state "this account is premium" is already true.
  await env.DB
    .prepare(
      `INSERT OR IGNORE INTO user_entitlements
         (user_id, sku, source, granted_by, granted_at)
       VALUES (?, ?, 'admin', ?, ?)`,
    )
    .bind(user.id, sku, session.email, Date.now())
    .run();
  return json({ ok: true, user: { email: user.email, display_name: user.display_name }, sku });
}

async function handleAdminRevoke(req, env, { session }) {
  const denied = requireAdmin(session);
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  const sku = body?.sku ?? 'cosmetics_v1';
  const user = await userByEmail(env, body?.email);
  if (!user) return err(404, 'no_such_user', 'no account with that email');

  // Revoke removes the row whatever its source. An admin taking premium
  // off a PAID account is a support action (chargeback cleanup, ToS) —
  // legal, but the response says what was deleted so it can't happen
  // unknowingly.
  const row = await env.DB
    .prepare('SELECT source FROM user_entitlements WHERE user_id = ? AND sku = ?')
    .bind(user.id, sku)
    .first();
  if (!row) return json({ ok: true, removed: null });
  await env.DB
    .prepare('DELETE FROM user_entitlements WHERE user_id = ? AND sku = ?')
    .bind(user.id, sku)
    .run();
  return json({ ok: true, removed: row.source });
}

async function handleAdminLookup(_req, env, { url, session }) {
  const denied = requireAdmin(session);
  if (denied) return denied;
  const user = await userByEmail(env, url.searchParams.get('email'));
  if (!user) return err(404, 'no_such_user', 'no account with that email');
  const rows = await env.DB
    .prepare(
      `SELECT sku, source, granted_by, granted_at, stripe_session_id
         FROM user_entitlements WHERE user_id = ? ORDER BY granted_at DESC`,
    )
    .bind(user.id)
    .all();
  return json({
    user: { email: user.email, display_name: user.display_name },
    entitlements: rows.results ?? [],
  });
}

/**
 * Browse/search every account, with premium state attached.
 *
 * The entitlement panel could only do an EXACT email lookup, which
 * assumed the admin already knew the address. In practice you know
 * someone as "the player called Bungus" — so this searches display name
 * and email together, and with no query at all just lists everyone.
 *
 * Admin-gated through requireAdmin, which 404s rather than 403s: this
 * returns the email address of every account on the service, and a route
 * that denies loudly is a route that confirms it exists.
 */
async function handleAdminUsers(_req, env, { url, session }) {
  const denied = requireAdmin(session);
  if (denied) return denied;

  const raw = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  // Escape LIKE metacharacters. Without this a search for "%" matches
  // every account and "_" silently matches any character, which reads as
  // the filter being broken.
  const esc = raw.replace(/[\\%_]/g, (m) => `\\${m}`);
  const like = `%${esc}%`;
  const hasQ = raw.length > 0 ? 1 : 0;
  const premiumOnly = url.searchParams.get('premium') === '1' ? 1 : 0;

  const n = (v, dflt, min, max) => {
    const x = parseInt(v ?? '', 10);
    return Number.isFinite(x) ? Math.max(min, Math.min(max, x)) : dflt;
  };
  const limit = n(url.searchParams.get('limit'), 50, 1, 200);
  const offset = n(url.searchParams.get('offset'), 0, 0, 1_000_000);

  // One WHERE, used by both the page query and the count, so the total
  // can never disagree with the rows it claims to be counting.
  const where = `
     WHERE (?1 = 0 OR LOWER(u.display_name) LIKE ?2 ESCAPE '\\'
                   OR LOWER(u.email) LIKE ?2 ESCAPE '\\')
       AND (?3 = 0 OR e.user_id IS NOT NULL)`;
  const from = `
      FROM users u
      LEFT JOIN user_entitlements e
        ON e.user_id = u.id AND e.sku = 'cosmetics_v1'`;

  const rows = await env.DB
    .prepare(
      `SELECT u.id, u.email, u.display_name, u.created_at, u.last_login_at,
              e.source AS premium_source, e.granted_at AS premium_at,
              e.granted_by AS premium_by
         ${from} ${where}
        ORDER BY COALESCE(u.last_login_at, u.created_at) DESC
        LIMIT ?4 OFFSET ?5`,
    )
    .bind(hasQ, like, premiumOnly, limit, offset)
    .all();

  const totals = await env.DB
    .prepare(`SELECT COUNT(*) AS n ${from} ${where}`)
    .bind(hasQ, like, premiumOnly)
    .first();

  // Unfiltered premium headcount, so the panel can show "2 of 50" without
  // a second round trip when a filter is active.
  const premiumTotal = await env.DB
    .prepare(
      `SELECT COUNT(*) AS n FROM user_entitlements WHERE sku = 'cosmetics_v1'`,
    )
    .first();

  return json({
    users: (rows.results ?? []).map(r => ({
      id: r.id,
      email: r.email,
      display_name: r.display_name,
      created_at: r.created_at,
      last_login_at: r.last_login_at ?? null,
      is_premium: r.premium_source != null,
      premium_source: r.premium_source ?? null,
      premium_at: r.premium_at ?? null,
      premium_by: r.premium_by ?? null,
    })),
    total: Number(totals?.n ?? 0),
    premium_total: Number(premiumTotal?.n ?? 0),
    limit,
    offset,
  });
}

export const routes = [
  { method: 'POST', pattern: '/api/checkout/cosmetics', auth: 'required', handle: handleCreateCheckout },
  // NOTE: the Stripe webhook is NOT in this table. Feature routes
  // dispatch below index.js's blanket session gate, and Stripe's POST
  // carries no cookie — it authenticates by signature instead, so
  // index.js carves it out before the gate, exactly like
  // /api/discord/interactions and for exactly the same reason.
  { method: 'GET',  pattern: '/api/admin/users', auth: 'required', handle: handleAdminUsers },
  { method: 'GET',  pattern: '/api/admin/entitlements', auth: 'required', handle: handleAdminLookup },
  { method: 'POST', pattern: '/api/admin/entitlements', auth: 'required', handle: handleAdminGrant },
  { method: 'POST', pattern: '/api/admin/entitlements/revoke', auth: 'required', handle: handleAdminRevoke },
];
