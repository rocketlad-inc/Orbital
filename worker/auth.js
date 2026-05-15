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
      `SELECT s.token, s.user_id, s.expires_at, u.email, u.display_name
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
