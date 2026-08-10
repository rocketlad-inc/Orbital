// Password hashing + session helpers. Uses Web Crypto only (works on Workers).

// Cloudflare Workers cap PBKDF2 iterations at 100,000. The stored hash
// embeds the iter count so older rows verify against whatever they used.
const PBKDF2_ITERS = 100_000;
const PBKDF2_HASH = 'SHA-256';
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const SESSION_BYTES = 32;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const enc = new TextEncoder();

function b64urlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pbkdf2(password, salt, iters) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: PBKDF2_HASH, salt, iterations: iters },
    key,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERS);
  return `pbkdf2$${PBKDF2_ITERS}$${b64urlEncode(salt)}$${b64urlEncode(hash)}`;
}

export async function verifyPassword(password, stored) {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iters = parseInt(parts[1], 10);
  const salt = b64urlDecode(parts[2]);
  const expected = b64urlDecode(parts[3]);
  const actual = await pbkdf2(password, salt, iters);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

export function newSessionToken() {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(SESSION_BYTES)));
}

export function newUserId() {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(12)));
}

export async function createSession(db, userId, userAgent) {
  const token = newSessionToken();
  const now = Date.now();
  await db
    .prepare('INSERT INTO sessions (token, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)')
    .bind(token, userId, now, now + SESSION_TTL_MS, userAgent ?? null)
    .run();
  return { token, expiresAt: now + SESSION_TTL_MS };
}

export async function lookupSession(db, token) {
  if (!token) return null;
  const row = await db
    .prepare(
      `SELECT s.token, s.user_id, s.expires_at, s.last_seen_at, u.email, u.display_name
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`,
    )
    .bind(token)
    .first();
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return null;
  }
  return row;
}

export async function deleteSession(db, token) {
  if (!token) return;
  await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
}

export function sessionCookie(token, expiresAt) {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  return `orbital_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

export function clearedCookie() {
  return 'orbital_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0';
}

export function readSessionCookie(req) {
  const cookie = req.headers.get('cookie');
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === 'orbital_session') return v ?? null;
  }
  return null;
}

// ============================================================
// Agent access — a keyed service credential, NOT a login bypass.
//
// The distinction matters. A "bypass" is an alternate path that skips
// auth; this is the opposite. An agent presents a shared secret to MINT
// an ordinary session for a clearly-labelled agent account, then acts
// through the exact same session pipeline as any player — every action
// attributable to a named user row, every session revocable, the whole
// thing switched off by removing one secret.
//
// Agent accounts are reachable ONLY here: their password_hash is a
// sentinel no password can produce (verifyPassword needs a 4-part
// 'pbkdf2$…' string and returns false for anything else), and they
// carry no google_sub / discord_id. So password login, Google, and
// Discord all dead-end on them by construction — the keyed endpoint is
// the sole door, and its key is a Cloudflare secret.
// ============================================================

/** Any password is rejected against this — see verifyPassword's format
 *  guard. Self-documenting so a human reading the users table knows why
 *  the row can't be logged into. */
const AGENT_PASSWORD_SENTINEL = '!agent-account-no-password-login';

/** Handles are embedded in an email and a display name, so keep them to
 *  a slug that can't inject anything or collide by whitespace. */
const AGENT_HANDLE_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/;

export function isValidAgentHandle(h) {
  return typeof h === 'string' && AGENT_HANDLE_RE.test(h);
}

/**
 * Constant-time string comparison.
 *
 * Hashes both sides to a fixed 32 bytes with SHA-256 before comparing,
 * so neither the length nor the content of the real key leaks through
 * timing — a naive `===` on the secret would short-circuit on the first
 * wrong byte and hand an attacker a byte-at-a-time oracle.
 */
export async function constantTimeEqual(a, b) {
  const ha = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(a ?? ''))));
  const hb = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(b ?? ''))));
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

/**
 * Get (or create) the agent user for a handle. Idempotent: the second
 * call with 'sim-alpha' returns the same row, so an agent keeps one
 * stable identity across sessions and its history accretes on one user.
 *
 * The email domain is `.local` on purpose — it can never receive mail,
 * so an agent account can't be pulled into email flows (password reset,
 * digests) and can't collide with a real player's address.
 */
export async function getOrCreateAgentUser(db, handle) {
  const email = `agent+${handle}@agents.orbital.local`;
  const existing = await db
    .prepare('SELECT id, email, display_name FROM users WHERE email = ?')
    .bind(email)
    .first();
  if (existing) return existing;

  const id = newUserId();
  const displayName = `[agent] ${handle}`.slice(0, 40);
  const now = Date.now();
  await db
    .prepare('INSERT INTO users (id, email, display_name, password_hash, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, email, displayName, AGENT_PASSWORD_SENTINEL, now, now)
    .run();
  return { id, email, display_name: displayName };
}
