// ============================================================
// Push notifications — the transport, the endpoints, and the fan-out.
//
// This sits BESIDE the Discord DM rather than replacing it. Discord
// reaches the players who linked an account; push reaches the phone in
// someone's pocket whether or not they use Discord at all, which in a
// game where a tick is an hour is the difference between "I came back
// and my freighter had been idle for a day" and not.
//
// WHY IT HOOKS INTO notify.sendDm INSTEAD OF BEING CALLED EVERYWHERE.
// There are eighteen places that already decided an event is worth
// telling a player about, with the category, the wording and the dedupe
// key all chosen. Calling push from each of them would be eighteen
// chances to forget one. The fan-out lives in sendDm, so every existing
// notification — and every future one — reaches both transports for
// free.
//
// The player's per-category preferences START shared with Discord: mute
// "senate" and you mute it everywhere, which is what a person usually
// means. They stop being shared for any category where the player has
// touched the phone switch specifically, because a daily briefing and a
// lock-screen interrupt do not deserve the same answer (migration 0133).
// The other thing that is NOT shared is the dedupe claim (see
// pushToUser).
//
// Endpoints:
//   GET    /api/push/key          the VAPID public key, for subscribe()
//                                 (auth required — index.js gates every
//                                 /api/* route that is not explicitly
//                                 carved out above the session check, and
//                                 only a signed-in player ever subscribes)
//   POST   /api/push/subscribe    store this device
//   POST   /api/push/unsubscribe  forget this device
//   POST   /api/push/test         send one to yourself, to prove it works
// ============================================================

import { sendPush } from './webpush.js';

/** Discord embeds are markdown; a notification body is plain text. */
function plain(s) {
  return String(s ?? '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/(^|\s)_(.+?)_(?=\s|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function json(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(data), { ...init, headers });
}
const err = (status, code, message) => json({ error: { code, message } }, { status });

/** Is push configured at all? Without keys every endpoint below says so
 *  plainly rather than failing in a way that looks like a bug. */
export function pushConfigured(env) {
  return !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

/**
 * Send one notification to every device a user has registered.
 *
 * DEDUPE IS PER-TRANSPORT. Discord's dedupe key and this one live in the
 * same table but in different namespaces ("push:" prefixed), because
 * they are different deliveries: a Discord DM that was already sent must
 * not silence the phone, and vice versa. Sharing one key would mean
 * whichever transport fired first won and the other never ran.
 */
export async function pushToUser(env, opts) {
  const { userId, category, dedupeKey = null, embed = {}, url = '/', actions = [] } = opts;
  if (!pushConfigured(env)) return { sent: false, reason: 'not_configured' };

  try {
    const subs = (await env.DB
      .prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?')
      .bind(userId).all()).results ?? [];
    if (!subs.length) return { sent: false, reason: 'no_subscription' };

    // The player's PHONE answer for this category, which is the shared
    // one until they say otherwise (migration 0133). Passing the
    // transport is what lets someone keep combat on the lock screen
    // while their Discord DMs stay quiet.
    const { categoryEnabled } = await import('./notify.js');
    if (!(await categoryEnabled(env, userId, category, 'push'))) {
      return { sent: false, reason: 'opted_out' };
    }

    if (dedupeKey) {
      try {
        await env.DB
          .prepare('INSERT INTO notification_log (user_id, game_id, category, dedupe_key, ok, created_ms) VALUES (?, ?, ?, ?, 1, ?)')
          .bind(userId, opts.gameId ?? null, category, `push:${dedupeKey}`, Date.now())
          .run();
      } catch {
        return { sent: false, reason: 'already_sent' };
      }
    }

    const payload = {
      title: plain(embed.title) || 'Orbital',
      body: plain(embed.description).slice(0, 300),
      url,
      // Collapses repeats about the same subject into one line in the
      // shade rather than a stack of four.
      tag: dedupeKey ? `orbital:${dedupeKey}` : `orbital:${category}`,
      category,
      // BUTTONS ON THE NOTIFICATION. Each one carries the order it
      // stands for; the service worker posts it back to /api/notify/act,
      // which applies it as the signed-in player through the game's own
      // routes. Android shows two, so producers send at most two.
      actions: actions.slice(0, 2).map(a => ({
        action: String(a.id),
        title: String(a.label),
        ...(a.reply ? { type: 'text', placeholder: String(a.placeholder ?? 'Reply') } : {}),
      })),
      act: Object.fromEntries(actions.slice(0, 2).map(a => [String(a.id), a.verb])),
    };

    let anySent = false;
    const dead = [];
    for (const sub of subs) {
      const res = await sendPush(env, sub, payload);
      if (res.ok) {
        anySent = true;
        await env.DB
          .prepare('UPDATE push_subscriptions SET last_ok_ms = ?, fail_count = 0, failed_at_ms = NULL WHERE endpoint = ?')
          .bind(Date.now(), sub.endpoint).run().catch?.(() => {});
      } else if (res.gone) {
        dead.push(sub.endpoint);
      } else {
        await env.DB
          .prepare('UPDATE push_subscriptions SET failed_at_ms = ?, fail_count = fail_count + 1 WHERE endpoint = ?')
          .bind(Date.now(), sub.endpoint).run().catch?.(() => {});
      }
    }
    // A subscription the browser has thrown away will never work again;
    // keeping it means pushing at a dead address forever.
    for (const endpoint of dead) {
      await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run();
    }

    if (!anySent && dedupeKey) {
      try {
        await env.DB.prepare('UPDATE notification_log SET ok = 0 WHERE user_id = ? AND dedupe_key = ?')
          .bind(userId, `push:${dedupeKey}`).run();
      } catch { /* bookkeeping only */ }
    }
    return { sent: anySent, devices: subs.length, removed: dead.length };
  } catch (e) {
    console.error('pushToUser threw', e);
    return { sent: false, reason: 'exception' };
  }
}

// ---- endpoints ----------------------------------------------------

async function handleKey(_req, env) {
  if (!pushConfigured(env)) return err(503, 'push_unconfigured', 'push notifications are not set up on this server');
  return json({ key: env.VAPID_PUBLIC_KEY });
}

async function handleSubscribe(req, env, { session }) {
  if (!pushConfigured(env)) return err(503, 'push_unconfigured', 'push notifications are not set up on this server');
  let body = {};
  try { body = await req.json(); } catch { body = {}; }

  const endpoint = String(body?.endpoint ?? '');
  const p256dh = String(body?.keys?.p256dh ?? '');
  const auth = String(body?.keys?.auth ?? '');
  if (!/^https:\/\//.test(endpoint)) return err(400, 'bad_request', 'endpoint must be an https URL');
  if (!p256dh || !auth) return err(400, 'bad_request', 'p256dh and auth are required');

  // The endpoint is the primary key, so re-subscribing the same device
  // moves it to the current user rather than stacking rows — which is
  // what happens on a shared phone when a second player signs in.
  await env.DB
    .prepare(
      `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, user_agent, created_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
         user_agent = excluded.user_agent, failed_at_ms = NULL, fail_count = 0`,
    )
    .bind(endpoint, session.user_id, p256dh, auth,
          (req.headers.get('user-agent') ?? '').slice(0, 200), Date.now())
    .run();
  return json({ ok: true });
}

async function handleUnsubscribe(req, env, { session }) {
  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  const endpoint = String(body?.endpoint ?? '');
  if (!endpoint) return err(400, 'bad_request', 'endpoint required');
  // Scoped to the caller: an endpoint is not a secret, and without this
  // anyone could unsubscribe anyone.
  await env.DB
    .prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?')
    .bind(endpoint, session.user_id).run();
  return json({ ok: true });
}

/** "Does this actually work on my phone?" — answerable without waiting
 *  for a game event, which is the difference between a feature people
 *  trust and one they assume is broken. */
async function handleTest(_req, env, { session }) {
  const res = await pushToUser(env, {
    userId: session.user_id,
    category: 'dm',
    embed: {
      title: 'Orbital notifications are on',
      description: 'This is what an alert looks like. Trade offers, senate votes and your daily report will arrive here.',
    },
    url: '/',
  });
  if (!res.sent) {
    const why = res.reason === 'no_subscription' ? 'this device is not subscribed yet'
      : res.reason === 'opted_out' ? 'notifications for this category are switched off'
      : res.reason === 'not_configured' ? 'push is not set up on this server'
      : 'the push service refused it';
    return err(409, 'not_sent', why);
  }
  return json({ ok: true, devices: res.devices });
}

export const routes = [
  { method: 'GET', pattern: /^\/api\/push\/key$/, auth: 'required', handle: handleKey },
  { method: 'POST', pattern: /^\/api\/push\/subscribe$/, auth: 'required', handle: handleSubscribe },
  { method: 'POST', pattern: /^\/api\/push\/unsubscribe$/, auth: 'required', handle: handleUnsubscribe },
  { method: 'POST', pattern: /^\/api\/push\/test$/, auth: 'required', handle: handleTest },
];
