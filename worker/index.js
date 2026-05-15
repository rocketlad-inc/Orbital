import {
  hashPassword,
  verifyPassword,
  createSession,
  lookupSession,
  deleteSession,
  newUserId,
  sessionCookie,
  clearedCookie,
  readSessionCookie,
} from './auth.js';
import { MIGRATIONS } from './_migrations_bundle.js';

export { Room } from './room.js';

// One-shot schema bootstrap. Idempotent — checks whether the `users` table
// exists before doing anything. Splits each SQL file into individual
// statements (SQLite/D1 requires one statement per prepare).
async function handleInit(req, env) {
  // Already initialized?
  try {
    await env.DB.prepare('SELECT 1 FROM users LIMIT 1').first();
    return json({ ok: true, status: 'already_initialized' });
  } catch (_) {
    // not initialized — fall through
  }

  const applied = [];
  for (const m of MIGRATIONS) {
    const stmts = m.sql
      .split(/;\s*(?:\r?\n|$)/)
      .map(s => s.replace(/^\s*--.*$/gm, '').trim())
      .filter(s => s.length > 0);
    for (const stmt of stmts) {
      try {
        await env.DB.prepare(stmt).run();
      } catch (e) {
        return json({
          ok: false,
          migration: m.name,
          statement: stmt.slice(0, 200),
          error: String(e?.message || e),
          applied,
        }, { status: 500 });
      }
    }
    applied.push(m.name);
  }
  return json({ ok: true, applied });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROOM_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;

function json(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(data), { ...init, headers });
}
function err(status, code, message) {
  return json({ error: { code, message } }, { status });
}
async function readJson(req) {
  try { return await req.json(); } catch { return null; }
}

function newRoomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------- auth ----------

function validateSignup(body) {
  if (!body || typeof body !== 'object') return 'invalid body';
  const { email, password, display_name } = body;
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) return 'invalid email';
  if (typeof password !== 'string' || password.length < 8) return 'password must be at least 8 characters';
  if (password.length > 200) return 'password too long';
  if (display_name != null && (typeof display_name !== 'string' || display_name.length > 40)) return 'invalid display_name';
  return null;
}

async function handleSignup(req, env) {
  const body = await readJson(req);
  const problem = validateSignup(body);
  if (problem) return err(400, 'bad_request', problem);

  const email = body.email.trim().toLowerCase();
  const displayName = (body.display_name?.trim() || email.split('@')[0]).slice(0, 40);
  const passwordHash = await hashPassword(body.password);
  const id = newUserId();
  const now = Date.now();

  try {
    await env.DB
      .prepare('INSERT INTO users (id, email, display_name, password_hash, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, email, displayName, passwordHash, now, now)
      .run();
  } catch (e) {
    if (String(e?.message || e).includes('UNIQUE')) return err(409, 'email_taken', 'email already registered');
    throw e;
  }

  const { token, expiresAt } = await createSession(env.DB, id, req.headers.get('user-agent'));
  return json(
    { user: { id, email, display_name: displayName } },
    { status: 201, headers: { 'set-cookie': sessionCookie(token, expiresAt) } },
  );
}

async function handleLogin(req, env) {
  const body = await readJson(req);
  if (!body || typeof body.email !== 'string' || typeof body.password !== 'string') {
    return err(400, 'bad_request', 'email and password required');
  }
  const email = body.email.trim().toLowerCase();
  const row = await env.DB
    .prepare('SELECT id, email, display_name, password_hash FROM users WHERE email = ?')
    .bind(email)
    .first();

  const stored = row?.password_hash ?? 'pbkdf2$210000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const ok = await verifyPassword(body.password, stored);
  if (!row || !ok) return err(401, 'invalid_credentials', 'invalid email or password');

  await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(Date.now(), row.id).run();
  const { token, expiresAt } = await createSession(env.DB, row.id, req.headers.get('user-agent'));
  return json(
    { user: { id: row.id, email: row.email, display_name: row.display_name } },
    { headers: { 'set-cookie': sessionCookie(token, expiresAt) } },
  );
}

async function handleLogout(req, env) {
  const token = readSessionCookie(req);
  await deleteSession(env.DB, token);
  return new Response(null, { status: 204, headers: { 'set-cookie': clearedCookie() } });
}

async function handleMe(req, env) {
  const session = await currentSession(req, env);
  if (!session) return err(401, 'unauthenticated', 'not signed in');
  return json({ user: { id: session.user_id, email: session.email, display_name: session.display_name } });
}

async function currentSession(req, env) {
  return lookupSession(env.DB, readSessionCookie(req));
}

// ---------- rooms ----------

function roomStub(env, roomId) {
  const id = env.ROOM.idFromName(roomId);
  return env.ROOM.get(id);
}

async function handleListRooms(_req, env) {
  const rows = await env.DB
    .prepare(
      `SELECT r.id, r.name, r.status, r.max_players, r.created_at, r.host_id, u.display_name AS host_name,
              (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) AS member_count
       FROM rooms r JOIN users u ON u.id = r.host_id
       WHERE r.status != 'closed'
       ORDER BY r.updated_at DESC
       LIMIT 50`,
    )
    .all();
  return json({ rooms: rows.results ?? [] });
}

// Rooms the current user is a member of, with each room's current game
// status if one has started. Used by the post-auth mode picker to offer a
// "resume" shortcut and (when there's a single in-progress game) to
// auto-redirect users back into their active game.
async function handleListMyRooms(_req, env, session) {
  const rows = await env.DB
    .prepare(
      `SELECT r.id, r.name, r.status, r.max_players, r.host_id, u.display_name AS host_name,
              (SELECT COUNT(*) FROM room_members m2 WHERE m2.room_id = r.id) AS member_count,
              g.id AS game_id, g.status AS game_status
       FROM room_members rm
       JOIN rooms r ON r.id = rm.room_id
       JOIN users u ON u.id = r.host_id
       LEFT JOIN games g ON g.id = r.id
       WHERE rm.user_id = ?
         AND r.status != 'closed'
       ORDER BY r.updated_at DESC
       LIMIT 50`,
    )
    .bind(session.user_id)
    .all();
  return json({ rooms: rows.results ?? [] });
}

async function handleCreateRoom(req, env, session) {
  const body = await readJson(req);
  const rawName = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!rawName) return err(400, 'bad_request', 'room name required');
  if (rawName.length > 60) return err(400, 'bad_request', 'name too long');

  const maxPlayers = Number.isInteger(body?.max_players) ? body.max_players : 4;
  if (maxPlayers < 2 || maxPlayers > 8) return err(400, 'bad_request', 'max_players must be 2-8');

  const id = newRoomId();
  const now = Date.now();

  await env.DB.batch([
    env.DB
      .prepare('INSERT INTO rooms (id, name, host_id, status, max_players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, rawName, session.user_id, 'lobby', maxPlayers, now, now),
    env.DB
      .prepare('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)')
      .bind(id, session.user_id, now),
  ]);

  // Initialise the DO with metadata + host as the first member.
  await roomStub(env, id).fetch('https://room/init', {
    method: 'POST',
    body: JSON.stringify({
      meta: { id, name: rawName, hostId: session.user_id, status: 'lobby', maxPlayers, createdAt: now },
      members: { [session.user_id]: { userId: session.user_id, displayName: session.display_name } },
    }),
  });

  return json({ room: { id, name: rawName, host_id: session.user_id, status: 'lobby', max_players: maxPlayers } }, { status: 201 });
}

async function handleJoinRoom(req, env, session, roomId) {
  if (!ROOM_ID_RE.test(roomId)) return err(400, 'bad_request', 'invalid room id');
  const room = await env.DB.prepare('SELECT id, max_players, status FROM rooms WHERE id = ?').bind(roomId).first();
  if (!room) return err(404, 'not_found', 'room not found');
  if (room.status === 'closed') return err(409, 'room_closed', 'room is closed');

  const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM room_members WHERE room_id = ?').bind(roomId).first();
  const already = await env.DB
    .prepare('SELECT 1 AS x FROM room_members WHERE room_id = ? AND user_id = ?')
    .bind(roomId, session.user_id)
    .first();

  if (!already) {
    if ((count?.c ?? 0) >= room.max_players) return err(403, 'room_full', 'room is full');
    await env.DB
      .prepare('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)')
      .bind(roomId, session.user_id, Date.now())
      .run();
    await env.DB.prepare('UPDATE rooms SET updated_at = ? WHERE id = ?').bind(Date.now(), roomId).run();
  }

  return json({ ok: true });
}

async function handleRoomSnapshot(_req, env, _session, roomId) {
  if (!ROOM_ID_RE.test(roomId)) return err(400, 'bad_request', 'invalid room id');
  const res = await roomStub(env, roomId).fetch('https://room/snapshot');
  return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
}

async function handleRoomConnect(req, env, session, roomId) {
  if (!ROOM_ID_RE.test(roomId)) return err(400, 'bad_request', 'invalid room id');
  if (req.headers.get('upgrade') !== 'websocket') return err(426, 'upgrade_required', 'websocket upgrade required');

  const member = await env.DB
    .prepare('SELECT 1 AS x FROM room_members WHERE room_id = ? AND user_id = ?')
    .bind(roomId, session.user_id)
    .first();
  if (!member) return err(403, 'not_member', 'join the room before connecting');

  const url = new URL('https://room/connect');
  url.searchParams.set('uid', session.user_id);
  url.searchParams.set('name', session.display_name || '');
  return roomStub(env, roomId).fetch(url.toString(), { headers: req.headers });
}

// ---------- routing ----------
//
// Feature modules contribute routes. A module exports an object:
//   { routes: [ { method, pattern, auth: 'required'|'public', handle } ] }
// where pattern is a string (exact match) or a RegExp; handle receives
// (req, env, ctx) with ctx = { url, session, params }.
//
// Modules registered below. New social features (factions, lobby controls,
// messaging, senate) should be added as imports here.
import * as lobby   from './lobby.js';
import * as factions from './factions.js';
import * as messages from './messages.js';
import * as senate  from './senate.js';

const FEATURE_MODULES = [lobby, factions, messages, senate];

function matchPattern(pattern, pathname) {
  if (typeof pattern === 'string') {
    return pattern === pathname ? {} : null;
  }
  const m = pathname.match(pattern);
  if (!m) return null;
  return m.groups ?? { _match: m };
}

async function dispatchFeatureRoute(req, env, url, session) {
  for (const mod of FEATURE_MODULES) {
    if (!mod || !Array.isArray(mod.routes)) continue;
    for (const r of mod.routes) {
      if (r.method !== req.method) continue;
      const params = matchPattern(r.pattern, url.pathname);
      if (params === null) continue;
      if (r.auth === 'required' && !session) {
        return err(401, 'unauthenticated', 'sign in required');
      }
      return r.handle(req, env, { url, session, params });
    }
  }
  return null;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname.startsWith('/api/')) {
      // one-shot bootstrap (idempotent; no-op once tables exist)
      if (req.method === 'POST' && url.pathname === '/api/__init') return handleInit(req, env);
      // unauthenticated routes
      if (req.method === 'POST' && url.pathname === '/api/auth/signup') return handleSignup(req, env);
      if (req.method === 'POST' && url.pathname === '/api/auth/login') return handleLogin(req, env);
      if (req.method === 'POST' && url.pathname === '/api/auth/logout') return handleLogout(req, env);
      if (req.method === 'GET'  && url.pathname === '/api/auth/me') return handleMe(req, env);

      // everything below requires a session
      const session = await currentSession(req, env);
      if (!session) return err(401, 'unauthenticated', 'sign in required');

      if (req.method === 'GET'  && url.pathname === '/api/rooms') return handleListRooms(req, env);
      if (req.method === 'POST' && url.pathname === '/api/rooms') return handleCreateRoom(req, env, session);
      if (req.method === 'GET'  && url.pathname === '/api/users/me/rooms') return handleListMyRooms(req, env, session);

      const joinMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/join$/);
      if (joinMatch && req.method === 'POST') return handleJoinRoom(req, env, session, joinMatch[1]);

      const snapMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)$/);
      if (snapMatch && req.method === 'GET') return handleRoomSnapshot(req, env, session, snapMatch[1]);

      const wsMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/ws$/);
      if (wsMatch) return handleRoomConnect(req, env, session, wsMatch[1]);

      // feature modules
      const featureResponse = await dispatchFeatureRoute(req, env, url, session);
      if (featureResponse) return featureResponse;

      return err(404, 'not_found', 'no such endpoint');
    }

    return env.ASSETS.fetch(req);
  },
};
