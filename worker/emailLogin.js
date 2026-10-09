// ============================================================================
// emailLogin.js — a button in an email that signs you in and seats you.
//
// The win-back email goes to people who signed up days ago and never came
// back; a fair share of them no longer know their password. So its button
// carries a token that signs its reader in, like a password-reset link:
// only the SHA-256 is stored, it works once, and it expires in a week.
//
//   GET  /api/email/go?t=<token>   a tiny page that posts the token back
//   POST /api/email/go             spends it: session cookie, then 303 to
//                                  /?play=winback&seat=<lobby>
//
// WHY THE PAGE IN BETWEEN. Two things break a plain GET-that-signs-in:
//   1. Mail scanners (Outlook Safe Links, corporate filters) fetch every
//      link in a message to check it. A one-use token spent on GET is
//      spent by the scanner before the person ever clicks. Scanners do
//      not submit forms.
//   2. The session cookie is SameSite=Strict, so a cookie set on a
//      navigation that began in Gmail is not sent on the page it lands
//      on. A POST from our own page is same-site, and so is the redirect
//      that follows it.
//
// A used, expired or unknown token is not an error page: it goes to the
// same seat link without signing in, and the ordinary sign-in takes over.
// ============================================================================

import { createSession, sessionCookie } from './auth.js';

const SITE = 'https://orbital-empire.com';
export const LOGIN_TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;
const ROOM_RE = /^[A-Za-z0-9_-]{6,40}$/;

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Where a click lands: the seat link the email would have used anyway. */
export function seatPath(roomId) {
  const seat = roomId && ROOM_RE.test(roomId) ? `&seat=${encodeURIComponent(roomId)}` : '';
  return `/?play=winback&from=winback${seat}`;
}

/**
 * Mint a sign-in link for one email. Returns the URL for the button, or
 * null if the token could not be stored (the caller falls back to the
 * plain seat link, which still works after an ordinary sign-in).
 */
export async function issueLoginLink(env, { userId, roomId = null, purpose = 'winback', nowMs = Date.now() }) {
  try {
    const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
    await env.DB
      .prepare(
        `INSERT INTO email_login_tokens (token_hash, user_id, purpose, room_id, created_ms, expires_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(await sha256Hex(token), userId, purpose, roomId, nowMs, nowMs + LOGIN_TOKEN_TTL_MS)
      .run();
    return `${SITE}/api/email/go?t=${token}`;
  } catch (e) {
    console.error('email login token failed', e);
    return null;
  }
}

/** Old tokens, a week past expiry, go. Called from the hourly win-back run. */
export async function pruneLoginTokens(env, nowMs = Date.now()) {
  try {
    await env.DB.prepare('DELETE FROM email_login_tokens WHERE expires_ms < ?').bind(nowMs - LOGIN_TOKEN_TTL_MS).run();
  } catch { /* housekeeping only */ }
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** GET: the page that posts the token. Spends nothing. */
export function landingPage(token) {
  const t = TOKEN_RE.test(token ?? '') ? token : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">
<title>Orbital</title>
<style>
  html,body{margin:0;height:100%;background:#060a10;color:#e8f0f7;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
  main{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:24px;box-sizing:border-box;text-align:center}
  .brand{font-weight:700;letter-spacing:.22em;color:#ffb84d}
  p{margin:0;color:#aebdcc}
  button{font:700 15px 'Segoe UI',Roboto,sans-serif;background:#ffb84d;color:#1d1404;border:0;border-radius:10px;padding:12px 26px;cursor:pointer}
</style></head>
<body><main>
  <div class="brand">ORBITAL</div>
  <p>Taking you to your seat…</p>
  <form id="go" method="post" action="/api/email/go">
    <input type="hidden" name="t" value="${esc(t)}">
    <button type="submit">Continue</button>
  </form>
</main>
<script>document.getElementById('go').submit();</script>
</body></html>`;
}

function redirect(path, cookie = null) {
  const headers = { location: path, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
  if (cookie) headers['set-cookie'] = cookie;
  return new Response(null, { status: 303, headers });
}

/** POST: spend the token in the statement that checks it, sign in, go. */
export async function spendLoginToken(env, token, userAgent, nowMs = Date.now()) {
  if (!TOKEN_RE.test(token ?? '')) return null;
  const hash = await sha256Hex(token);
  const spent = await env.DB
    .prepare('UPDATE email_login_tokens SET used_ms = ? WHERE token_hash = ? AND used_ms IS NULL AND expires_ms > ?')
    .bind(nowMs, hash, nowMs).run();
  if ((spent.meta?.changes ?? 0) !== 1) {
    // Used or expired: still send them toward the lobby the email named.
    const row = await env.DB.prepare('SELECT room_id FROM email_login_tokens WHERE token_hash = ?').bind(hash).first();
    return { ok: false, roomId: row?.room_id ?? null };
  }
  const row = await env.DB
    .prepare(`SELECT t.user_id, t.room_id FROM email_login_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`)
    .bind(hash).first();
  if (!row) return { ok: false, roomId: null };
  const { token: sess, expiresAt } = await createSession(env.DB, row.user_id, userAgent);
  await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(nowMs, row.user_id).run();
  return { ok: true, roomId: row.room_id, cookie: sessionCookie(sess, expiresAt) };
}

async function handleGet(_req, _env, ctx) {
  return new Response(landingPage(ctx.url.searchParams.get('t')), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex',
    },
  });
}

async function handlePost(req, env) {
  // Only our own landing page posts here. A form on another site could
  // otherwise sign a visitor into someone else's account.
  const origin = req.headers.get('origin');
  if (origin && origin !== SITE && origin !== new URL(req.url).origin) return redirect('/');
  let token = null;
  try {
    const form = await req.formData();
    token = form.get('t');
  } catch { /* not a form */ }
  const res = typeof token === 'string' ? await spendLoginToken(env, token, req.headers.get('user-agent')) : null;
  if (res?.ok) return redirect(seatPath(res.roomId), res.cookie);
  return redirect(seatPath(res?.roomId ?? null));
}

export const routes = [
  { method: 'GET',  pattern: '/api/email/go', auth: 'none', handle: handleGet },
  { method: 'POST', pattern: '/api/email/go', auth: 'none', handle: handlePost },
];
