// ============================================================
// "Your watch is asking to give orders." Asked in the game, answered in
// the game.
//
// WHY THIS REPLACES A LAUNCH URL. The watch used to hand the phone
// `/?w=<code>&ws=wear_orders` and the whole grant lived in a script in
// the page shell. That only works on a COLD start: with the game already
// open, the launch brings it forward, no document loads, the script
// never runs, nobody is asked -- and the watch polls for a token that
// will never exist. Players reported exactly that: "it goes to the app
// after I hit connect but the app doesn't update me to let me do it".
//
// It also broke a second way. The watch reuses its pairing code for a
// day, so a watch that had already paired handed over a code the server
// had bound once; the insert hit the primary key, the bind answered 409,
// and the fetch that made it threw the answer away.
//
// So the ask is now a ROW, not a URL:
//
//   POST /wear/<token>/request-orders   the watch files it, against the
//                                       token it already holds -- and is
//                                       granted on the spot, because that
//                                       token is the proof of ownership
//                                       the phone was being asked for
//   GET  /api/me/wear-requests          any ask still waiting on a person
//   POST /api/me/wear-requests/<code>/allow|deny
//
// A grant mints a NEW token at 'wear_orders' and drops it into
// widget_pairings under the request's code, which is the machinery the
// watch already polls -- nothing new to collect it with. A token is
// still never upgraded in place: orders are a new row, revocable on its
// own, exactly as before.
//
// The allow/deny pair is kept for the asks a person does have to answer:
// nothing files one today, and a route that exists for the case where
// the device cannot vouch for itself is worth more than one invented
// later under pressure.
// ============================================================

import { authorizeWear } from './wear.js';
import { mintWidgetToken } from './widget.js';
import { sendDm } from './notify.js';

/** How long an unanswered ask stays askable. Long enough to pick the
 *  phone up, short enough that a forgotten tap does not sit there for a
 *  day waiting to be said yes to by accident. */
const REQUEST_TTL_MS = 30 * 60 * 1000;

const CODE_RE = /^[A-Za-z0-9_-]{16,64}$/;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function err(status, code, message) {
  return json({ error: { code, message } }, status);
}

/**
 * POST /wear/<token>/request-orders  {code}
 *
 * The watch files the ask with the token it already has, so the server
 * knows whose watch it is without the phone being involved at all. The
 * code is the watch's fresh pairing code: the one it will poll.
 *
 * AND IT IS GRANTED ON THE SPOT. The question the phone used to ask was
 * "is this watch yours?", and the token answers it: this device already
 * holds a wear grant for this account, minted behind the session cookie,
 * so it can already read the whole empire and vote in the senate.
 * Asking a second time adds a step without adding a decision -- and the
 * step was where players got stuck.
 *
 * THE PROMPT STILL GUARDS THE ONE PATH THAT NEEDS IT: a FIRST pairing
 * arrives as a URL the phone is asked to open, and anyone who can get
 * that URL opened while you are signed in would otherwise attach their
 * own device to your account. That path keeps its confirm
 * (public/index.html), and nothing here touches it.
 *
 * An upgrade is never silent, though: the phone is told, so a watch that
 * gained orders without you is something you find out about and can
 * revoke.
 */
export async function handleWearRequestOrders(req, env, { params }) {
  const auth = await authorizeWear(env, params.token);
  if (auth.error) return auth.error;

  let body;
  try { body = await req.json(); } catch { return err(400, 'bad_request', 'invalid json'); }
  const code = String(body?.code ?? '');
  if (!CODE_RE.test(code)) return err(400, 'bad_request', 'invalid code');

  const now = Date.now();
  // One live ask per player. A second tap replaces the first rather than
  // stacking two prompts on the phone for the same watch.
  await env.DB
    .prepare("UPDATE wear_order_requests SET decision = 'superseded', decided_ms = ? WHERE user_id = ? AND decision IS NULL")
    .bind(now, auth.userId).run().catch(() => {});
  try {
    await env.DB
      .prepare('INSERT INTO wear_order_requests (code, user_id, created_ms) VALUES (?, ?, ?)')
      .bind(code, auth.userId, now).run();
  } catch {
    return err(409, 'conflict', 'that code is already in use');
  }

  // Already yours: grant it, and leave the row behind marked 'auto' so
  // the history of what this account allowed is still one table.
  const token = await mintWidgetToken(env, auth.userId, 'watch', 'wear_orders');
  try {
    await env.DB
      .prepare('INSERT INTO widget_pairings (code, token, user_id, created_ms) VALUES (?, ?, ?, ?)')
      .bind(code, token, auth.userId, now).run();
  } catch {
    return err(409, 'conflict', 'that code is already in use');
  }
  await env.DB
    .prepare("UPDATE wear_order_requests SET decision = 'auto', decided_ms = ? WHERE code = ?")
    .bind(now, code).run().catch(() => {});

  // Told, not asked. A grant you never see is one you never revoke.
  sendDm(env, {
    userId: auth.userId,
    category: 'security',
    dedupeKey: `wearorders:${code}`,
    url: '/',
    embed: {
      title: 'Your watch can now give orders',
      description: 'A watch already paired to this account asked for fleet orders and was allowed. '
        + 'If that was not you, revoke it in your account settings.',
    },
  }).catch(() => {});

  return json({ ok: true, allowed: true });
}

/** GET /api/me/wear-requests -- what the game asks the player about. */
async function handleList(_req, env, { session }) {
  if (!session) return err(401, 'unauthenticated', 'sign in required');
  const row = await env.DB
    .prepare(
      `SELECT code, created_ms FROM wear_order_requests
        WHERE user_id = ? AND decision IS NULL AND created_ms > ?
        ORDER BY created_ms DESC LIMIT 1`,
    )
    .bind(session.user_id, Date.now() - REQUEST_TTL_MS)
    .first()
    .catch(() => null);
  return json({ ok: true, request: row ? { code: String(row.code), at: Number(row.created_ms) } : null });
}

/**
 * POST /api/me/wear-requests/<code>/allow|deny
 *
 * Allow mints the orders token and binds it to the code; deny closes the
 * ask and leaves the watch exactly as it was -- paired, read-only, with
 * its senate vote. A watch that is refused keeps working, because a
 * watch that stopped working over one answer would be the worse outcome.
 */
async function handleDecide(req, env, { session, params, url }) {
  if (!session) return err(401, 'unauthenticated', 'sign in required');
  const code = String(params.code ?? '');
  if (!CODE_RE.test(code)) return err(400, 'bad_request', 'invalid code');
  const allow = url.pathname.endsWith('/allow');

  const row = await env.DB
    .prepare('SELECT user_id, created_ms, decision FROM wear_order_requests WHERE code = ?')
    .bind(code).first();
  // Somebody else's ask is not yours to answer, and a stale one is gone.
  if (!row || row.user_id !== session.user_id) return err(404, 'not_found', 'no such request');
  if (row.decision) return err(409, 'conflict', 'that request was already answered');
  if (Date.now() - Number(row.created_ms) > REQUEST_TTL_MS) {
    await env.DB.prepare("UPDATE wear_order_requests SET decision = 'expired', decided_ms = ? WHERE code = ?")
      .bind(Date.now(), code).run().catch(() => {});
    return err(410, 'expired', 'that request timed out — ask again from the watch');
  }

  if (allow) {
    const token = await mintWidgetToken(env, session.user_id, 'watch', 'wear_orders');
    try {
      await env.DB
        .prepare('INSERT INTO widget_pairings (code, token, user_id, created_ms) VALUES (?, ?, ?, ?)')
        .bind(code, token, session.user_id, Date.now()).run();
    } catch {
      return err(409, 'conflict', 'that code is already in use');
    }
  }
  await env.DB
    .prepare('UPDATE wear_order_requests SET decision = ?, decided_ms = ? WHERE code = ?')
    .bind(allow ? 'allowed' : 'denied', Date.now(), code).run();
  return json({ ok: true, allowed: allow });
}

export const routes = [
  {
    method: 'GET',
    pattern: /^\/api\/me\/wear-requests$/,
    auth: 'required',
    handle: handleList,
  },
  {
    method: 'POST',
    pattern: /^\/api\/me\/wear-requests\/(?<code>[A-Za-z0-9_-]{16,64})\/(?:allow|deny)$/,
    auth: 'required',
    handle: handleDecide,
  },
];

export const WEAR_REQUEST_ORDERS_RE = /^\/wear\/([A-Za-z0-9_-]{8,64})\/request-orders$/;
