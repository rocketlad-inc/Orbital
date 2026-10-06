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
//      checkout.session.completed / .async_payment_succeeded grant the
//      entitlement; on charge.refunded revoke it.
//   3. Admin override                -> grant/revoke by email, audited.
//   4. Gifts (0153)                   -> a checkout with gift:true mints a
//      code instead of granting; POST /api/commission/redeem turns the
//      code into the Commission on whoever redeems it.
//
// SURFACES (0153). Every checkout says where it started (profile, lobby
// flag picker, designer, end of game, the thank-you card). It rides into
// Stripe's metadata and onto the entitlement row, and every checkout
// attempt is logged, so the dashboard can say which surface sells and
// which only adds noise.
//
// WHAT AN ENTITLEMENT GATES. Looks -- premium ship icon variants, flag
// emblems, megastructure looks, colony/station styles -- and, since
// 2026-10-06, a host's game feed in their OWN Discord server
// (gameFeed.js serverDestination). The validators in index.js
// (icon_variant) and emblems.js (normalizeEmblem) and the feed consult
// hasEntitlement(). If a future sku wants to gate anything the
// simulation can feel, the answer is no.
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

// Ship icon variants: A-I free; J-S and T-Y (the visual overhaul's new
// designs, homage line included) premium (mirror of PREMIUM_VARIANTS
// in src/components/ShipIcons.tsx — same keep-in-sync arrangement as
// emblems). One validator for every save path so the rule can't drift
// between the build queue, the designer and the account template store.
const ICON_VARIANT_RE = /^[A-Y]$/;
const PREMIUM_ICON_VARIANTS = new Set(['J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y']);

// Megastructure looks: ONE per kind is free, the default 'A'; every other
// look on every kind needs the Commission (2026-10-05). A rule, not a
// per-kind list, so new art is covered without an edit here. Mirror of
// isPremiumStructureVariant in src/components/StructureIcons.tsx.
const FREE_STRUCTURE_VARIANT = 'A';

/** A megastructure look pick: null when allowed, else an error body. */
export async function validateStructureVariant(env, userId, kind, v) {
  if (v && v !== FREE_STRUCTURE_VARIANT && !(await hasEntitlement(env, userId))) {
    return { code: 'premium_required', message: 'that design needs the Commander\u2019s Commission' };
  }
  return null;
}

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

/** Where a checkout may say it started. Anything else is recorded as
 *  'other' rather than trusted: the value only ever labels a sale on the
 *  dashboard, it never decides anything. */
export const COMMISSION_SURFACES = new Set([
  'profile', 'lobby-flag', 'designer', 'endgame', 'thanks-card', 'skins',
  // The game-feed settings: "post this game in your own Discord server".
  'discord-feed',
]);

/** Gift codes: 12 characters from an alphabet with no lookalikes (no
 *  0/O, 1/I), about 60 bits, so guessing one is not a strategy. Stored
 *  bare; shown as XXXX-XXXX-XXXX. */
const GIFT_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newGiftCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let s = '';
  for (const b of bytes) s += GIFT_ALPHABET[b % GIFT_ALPHABET.length];
  return s;
}
export function normalizeGiftCode(raw) {
  const s = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-HJ-NP-Z2-9]{12}$/.test(s) ? s : null;
}
const showGiftCode = (c) => `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}`;

/** One analytics row per checkout attempt, with how it went. Not under
 *  /api/games, so the dispatch chokepoint never logs it on its own. */
async function logCheckout(env, session, { surface, gift, status, result }) {
  try {
    const { logEvent } = await import('./analytics.js');
    await logEvent(env, {
      userId: session.user_id,
      kind: 'commission/checkout',
      payload: { from: surface, kind: gift ? 'gift' : 'self', result },
      status,
    });
  } catch (e) { console.error('checkout log failed', e); }
}

async function handleCreateCheckout(req, env, { url, session }) {
  const sku = 'cosmetics_v1';
  // Body is optional: older clients POST with none, and get the old
  // behaviour (a purchase for themselves, surface 'other').
  const body = await req.json().catch(() => null);
  const gift = body?.gift === true;
  const surface = COMMISSION_SURFACES.has(body?.surface) ? body.surface : 'other';
  const priceId = env[SKUS[sku].priceEnv];
  if (!env.STRIPE_SECRET_KEY || !priceId) {
    await logCheckout(env, session, { surface, gift, status: 400, result: 'not_configured' });
    return err(400, 'not_configured', 'purchases are not enabled on this server');
  }
  // Repurchase guard — Stripe would happily charge twice; we would grant
  // once (PK collision) and owe a refund. Cheaper to refuse here. A GIFT
  // is the one purchase a holder can make: it is for someone else.
  if (!gift && await hasEntitlement(env, session.user_id, sku)) {
    await logCheckout(env, session, { surface, gift, status: 409, result: 'already_owned' });
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
    'metadata[surface]': surface,
    'metadata[gift]': gift ? '1' : '0',
    customer_email: session.email,
    success_url: `${origin}/?purchase=${gift ? 'gift' : 'success'}`,
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
    await logCheckout(env, session, { surface, gift, status: 502, result: 'stripe_error' });
    return err(502, 'stripe_error', 'could not start checkout — try again in a minute');
  }
  await logCheckout(env, session, { surface, gift, status: 200, result: 'started' });
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
export async function verifyStripeSignature(rawBody, header, secret) {
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

  // BOTH COMPLETION EVENTS GRANT, and that is not belt-and-braces.
  //
  // A card session arrives as checkout.session.completed with
  // payment_status 'paid'. A DELAYED method — bank debit, and several of
  // the wallets Stripe now enables by default through dynamic payment
  // methods — arrives as completed with payment_status 'unpaid', and the
  // money lands days later as async_payment_succeeded.
  //
  // This used to handle only the first event, and skip an unpaid session
  // with a comment promising that async_payment_succeeded would catch it
  // later. Nothing handled that event. A player paying by bank debit
  // would have been charged and granted nothing, silently, with the
  // Stripe dashboard showing a successful payment — which is the worst
  // shape a bug in a money path can take. Never shipped: no Stripe key
  // has ever been configured, so nothing was ever charged.
  if (event.type === 'checkout.session.completed'
    || event.type === 'checkout.session.async_payment_succeeded') {
    const userId = obj.client_reference_id;
    const sku = obj.metadata?.sku ?? 'cosmetics_v1';
    // Still unpaid on `completed` is the delayed case: acknowledge and
    // wait for the async event rather than granting on a promise.
    if (obj.payment_status !== 'paid') return json({ received: true });
    if (!userId || !SKUS[sku]) {
      console.error('webhook: paid session with no grantable target', obj.id);
      return json({ received: true });
    }
    const surface = typeof obj.metadata?.surface === 'string' ? obj.metadata.surface.slice(0, 24) : null;
    // A GIFT mints a code for the buyer to pass on; nothing is granted
    // to the buyer. The session id is UNIQUE on the gift row, so a
    // redelivery (or both completion events) mints exactly one code.
    if (obj.metadata?.gift === '1') {
      if (!obj.id) {
        console.error('webhook: paid gift session with no id');
        return json({ received: true });
      }
      await env.DB
        .prepare(
          `INSERT OR IGNORE INTO commission_gifts
             (code, sku, buyer_user_id, stripe_session_id, stripe_payment_intent, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(newGiftCode(), sku, userId, obj.id, obj.payment_intent ?? null, Date.now())
        .run();
      return json({ received: true });
    }
    // INSERT OR IGNORE twice over: the (user, sku) PK absorbs an admin
    // grant already existing; the session-id UNIQUE absorbs redelivery —
    // including the same session arriving once per event type.
    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO user_entitlements
           (user_id, sku, source, stripe_session_id, stripe_payment_intent, granted_at, surface)
         VALUES (?, ?, 'stripe', ?, ?, ?, ?)`,
      )
      .bind(userId, sku, obj.id ?? null, obj.payment_intent ?? null, Date.now(), surface)
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
      // A refunded GIFT: void the code so it can no longer be redeemed,
      // and if someone already redeemed it, the Commission it gave goes
      // back on the shelf too — the money behind it has been returned.
      const g = await env.DB
        .prepare('SELECT code FROM commission_gifts WHERE stripe_payment_intent = ?')
        .bind(intent)
        .first();
      if (g) {
        await env.DB.batch([
          env.DB.prepare('UPDATE commission_gifts SET voided_at = COALESCE(voided_at, ?) WHERE code = ?')
            .bind(Date.now(), g.code),
          env.DB.prepare('DELETE FROM user_entitlements WHERE gift_code = ?').bind(g.code),
        ]);
      }
    }
    return json({ received: true });
  }

  // Every other event type: acknowledged and ignored. Stripe sends
  // whatever the dashboard's endpoint config subscribes to; being loud
  // about unhandled types just fills the retry queue.
  return json({ received: true });
}

// ---------------------------------------------------------------- gifts

/** GET /api/commission/gifts — the codes this account bought for others. */
async function handleListGifts(_req, env, { session }) {
  const rows = (await env.DB
    .prepare(
      `SELECT g.code, g.created_at, g.redeemed_at, g.voided_at, u.display_name AS redeemed_by_name
         FROM commission_gifts g LEFT JOIN users u ON u.id = g.redeemed_by
        WHERE g.buyer_user_id = ?
        ORDER BY g.created_at DESC
        LIMIT 50`,
    )
    .bind(session.user_id)
    .all()).results ?? [];
  return json({
    gifts: rows.map(r => ({
      code: showGiftCode(r.code),
      created_at: r.created_at,
      redeemed_at: r.redeemed_at ?? null,
      redeemed_by_name: r.redeemed_by_name ?? null,
      voided: r.voided_at != null,
    })),
  });
}

/**
 * POST /api/commission/redeem { code } — a gift becomes this account's
 * Commission. The claim and the grant are ONE batch, and the grant only
 * inserts if the claim just named this account, so two people racing
 * for one code cannot both end up holding it.
 */
async function handleRedeemGift(req, env, { session }) {
  const body = await req.json().catch(() => null);
  const code = normalizeGiftCode(body?.code);
  if (!code) return err(400, 'bad_code', 'that does not look like a gift code (12 letters and numbers)');
  if (await hasEntitlement(env, session.user_id)) {
    return err(409, 'already_owned', 'this account already holds the Commission — pass the code to someone who does not');
  }
  const g = await env.DB
    .prepare('SELECT code, sku, redeemed_by, voided_at FROM commission_gifts WHERE code = ?')
    .bind(code)
    .first();
  if (!g || g.voided_at != null) return err(404, 'no_such_gift', 'no gift with that code');
  if (g.redeemed_by) return err(409, 'already_redeemed', 'that gift has already been redeemed');
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE commission_gifts SET redeemed_by = ?, redeemed_at = ?
        WHERE code = ? AND redeemed_by IS NULL AND voided_at IS NULL`,
    ).bind(session.user_id, now, code),
    env.DB.prepare(
      `INSERT OR IGNORE INTO user_entitlements (user_id, sku, source, granted_at, surface, gift_code)
       SELECT ?, sku, 'gift', ?, 'gift', code FROM commission_gifts
        WHERE code = ? AND redeemed_by = ?`,
    ).bind(session.user_id, now, code, session.user_id),
  ]);
  if (!(await hasEntitlement(env, session.user_id))) {
    return err(409, 'already_redeemed', 'that gift has already been redeemed');
  }
  return json({ ok: true });
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
  { method: 'GET',  pattern: '/api/commission/gifts', auth: 'required', handle: handleListGifts },
  { method: 'POST', pattern: '/api/commission/redeem', auth: 'required', handle: handleRedeemGift },
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
