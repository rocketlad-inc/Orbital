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
import { verifyGoogleIdToken } from './google.js';
import { MIGRATIONS } from './_migrations_bundle.js';
import { GIT_SHA, BUILT_AT } from './_version.js';

export { Room } from './room.js';

// Tracks which migrations have been applied so /api/__init can be re-run
// safely to apply just the new ones. D1 manages this internally when
// wrangler is used; this is the same idea, in worker code, for the
// win32/arm64 case where wrangler can't run locally.
async function ensureMigrationsTable(db) {
  await db
    .prepare('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)')
    .run();
}

async function handleInit(req, env) {
  await ensureMigrationsTable(env.DB);

  // Backfill: if the users table exists but _migrations is empty, this DB
  // was initialized before tracking was added. Mark every existing migration
  // up to the latest known schema as applied so we don't try to re-run them.
  const trackedCount = await env.DB.prepare('SELECT COUNT(*) AS c FROM _migrations').first();
  if ((trackedCount?.c ?? 0) === 0) {
    try {
      await env.DB.prepare('SELECT 1 FROM users LIMIT 1').first();
      // users exists -> backfill the migrations that must have produced it
      const knownPriorMigrations = [
        '0001_init.sql',
        '0002_rooms.sql',
        '0003_game_state.sql',
        '0004_senate_effects.sql',
        '0005_empire_identity_and_starter_fleet.sql',
      ];
      const now = Date.now();
      for (const name of knownPriorMigrations) {
        await env.DB
          .prepare('INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?)')
          .bind(name, now)
          .run();
      }
    } catch (_) {
      // users doesn't exist yet — fresh DB, nothing to backfill
    }
  }

  const applied = await env.DB.prepare('SELECT name FROM _migrations').all();
  const done = new Set((applied.results ?? []).map(r => r.name));

  const newlyApplied = [];
  // Some errors are recoverable — D1 throws "duplicate column name"
  // when an ADD COLUMN already ran on a prior partial application,
  // "already exists" for CREATE TABLE IF NOT EXISTS edge cases, etc.
  // Treating these as success lets a re-run finish the migration
  // instead of permanently bricking the loop. NOT_FATAL_RE matches
  // those + similar repeatable-statement failures.
  const NOT_FATAL_RE = /duplicate column|already exists|no such column.*to drop/i;
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    const stmts = m.sql
      .split(/;\s*(?:\r?\n|$)/)
      .map(s => s.replace(/^\s*--.*$/gm, '').trim())
      .filter(s => s.length > 0);
    for (const stmt of stmts) {
      try {
        await env.DB.prepare(stmt).run();
      } catch (e) {
        const msg = String(e?.message || e);
        if (NOT_FATAL_RE.test(msg)) {
          // Already-applied artifact — log and continue. The whole
          // migration still gets stamped as applied below so we don't
          // retry it next isolate.
          console.warn(`migration ${m.name} stmt skipped (already applied):`, msg);
          continue;
        }
        return json({
          ok: false,
          migration: m.name,
          statement: stmt.slice(0, 200),
          error: msg,
          newlyApplied,
        }, { status: 500 });
      }
    }
    await env.DB
      .prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)')
      .bind(m.name, Date.now())
      .run();
    newlyApplied.push(m.name);
  }
  return json({ ok: true, newlyApplied, alreadyApplied: [...done] });
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

// 8-char shareable code; alphabet excludes lookalikes (0/O, 1/I) so it's
// readable when typed by hand.
function newInviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
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

async function handleGoogleAuth(req, env) {
  const body = await readJson(req);
  if (!body || typeof body.id_token !== 'string') {
    return err(400, 'bad_request', 'id_token required');
  }

  let payload;
  try {
    payload = await verifyGoogleIdToken(body.id_token, env.GOOGLE_CLIENT_ID);
  } catch (e) {
    const code = e?.code ?? 'verify_failed';
    if (code === 'server_misconfigured') {
      return err(500, code, 'server is missing GOOGLE_CLIENT_ID');
    }
    return err(401, code, 'google id token rejected');
  }

  const googleSub = String(payload.sub);
  const email = String(payload.email).trim().toLowerCase();
  // Prefer the user-supplied display name (signup-style "call sign"),
  // fall back to Google's name, then to the email local-part.
  const displayName = (
    (typeof body.display_name === 'string' && body.display_name.trim()) ||
    (typeof payload.name === 'string' && payload.name.trim()) ||
    email.split('@')[0]
  ).slice(0, 40);

  const now = Date.now();

  // Three cases, in order:
  //   1. We already know this google_sub → log them in.
  //   2. We know this email (from password signup) → attach google_sub.
  //   3. New user → create row with google_sub, no password.
  let userId, userEmail, userDisplayName;

  const bySub = await env.DB
    .prepare('SELECT id, email, display_name FROM users WHERE google_sub = ?')
    .bind(googleSub)
    .first();

  if (bySub) {
    userId = bySub.id;
    userEmail = bySub.email;
    userDisplayName = bySub.display_name;
    await env.DB
      .prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
      .bind(now, userId)
      .run();
  } else {
    const byEmail = await env.DB
      .prepare('SELECT id, email, display_name FROM users WHERE email = ?')
      .bind(email)
      .first();
    if (byEmail) {
      // Link this Google account to the existing email-based user.
      userId = byEmail.id;
      userEmail = byEmail.email;
      userDisplayName = byEmail.display_name;
      await env.DB
        .prepare('UPDATE users SET google_sub = ?, last_login_at = ? WHERE id = ?')
        .bind(googleSub, now, userId)
        .run();
    } else {
      // Brand-new user — provision row. password_hash is '' (empty)
      // rather than NULL: the column stays NOT NULL (see migration
      // 0027 for why we avoid relaxing it), and verifyPassword rejects
      // '' so this account can never be logged into via the password
      // form — Google is its only entry point unless it later sets a
      // password.
      userId = newUserId();
      userEmail = email;
      userDisplayName = displayName;
      try {
        await env.DB
          .prepare(
            'INSERT INTO users (id, email, display_name, password_hash, google_sub, created_at, last_login_at) ' +
            "VALUES (?, ?, ?, '', ?, ?, ?)",
          )
          .bind(userId, userEmail, userDisplayName, googleSub, now, now)
          .run();
      } catch (e) {
        // Race: another request created the same email between the lookup
        // and the insert. Re-fetch and attach.
        if (String(e?.message || e).includes('UNIQUE')) {
          const reFetch = await env.DB
            .prepare('SELECT id, email, display_name FROM users WHERE email = ?')
            .bind(email)
            .first();
          if (!reFetch) throw e;
          userId = reFetch.id;
          userEmail = reFetch.email;
          userDisplayName = reFetch.display_name;
          await env.DB
            .prepare('UPDATE users SET google_sub = ?, last_login_at = ? WHERE id = ?')
            .bind(googleSub, now, userId)
            .run();
        } else {
          throw e;
        }
      }
    }
  }

  const { token, expiresAt } = await createSession(env.DB, userId, req.headers.get('user-agent'));
  return json(
    { user: { id: userId, email: userEmail, display_name: userDisplayName } },
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
              (r.password_hash IS NOT NULL) AS has_password,
              (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) AS member_count
       FROM rooms r JOIN users u ON u.id = r.host_id
       WHERE r.status != 'closed'
       ORDER BY r.updated_at DESC
       LIMIT 50`,
    )
    .all();
  const rooms = (rows.results ?? []).map(r => ({ ...r, has_password: !!r.has_password }));
  return json({ rooms });
}

// Rooms the current user is a member of, with each room's current game
// status if one has started. Used by the post-auth mode picker to offer a
// "resume" shortcut and (when there's a single in-progress game) to
// auto-redirect users back into their active game.
async function handleListMyRooms(_req, env, session) {
  // Defensive self-heal: re-insert missing room_members rows for any
  // active game where the user owns a faction. game_factions is the
  // canonical "this user belongs in this room" record — /state and
  // /joinable-bodies both auth off it, not room_members, so a missing
  // membership row is a UI-only orphan: the client polls /state fine
  // but the lobby's My Games filter (which DOES key off room_members)
  // shows nothing, and the player looks kicked.
  //
  // Player-reported repro: latecomer joined via late-join (writes
  // room_members + game_factions), played for a while, hard-reset, came
  // back — game_factions intact, room_members row gone. Root cause of
  // the deletion is still unknown (host-kick is the only DELETE I can
  // find and it's blocked after game start), but the recovery is
  // unambiguous: if the faction exists, the membership should exist.
  //
  // INSERT OR IGNORE is safe and idempotent; the inner SELECT filters to
  // rooms whose backing game exists and is active or in lobby, so we
  // don't resurrect membership for completed/abandoned matches.
  try {
    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at)
         SELECT g.id, gf.user_id, ?1
           FROM game_factions gf
           JOIN games g ON g.id = gf.game_id
          WHERE gf.user_id = ?2
            AND g.status IN ('active', 'lobby')`,
      )
      .bind(Date.now(), session.user_id)
      .run();
  } catch (e) {
    // Best-effort: if the self-heal fails, fall through to the existing
    // query. Worst case the player still sees the empty list — same as
    // before this commit, no regression.
    console.warn('handleListMyRooms: self-heal insert failed', e);
  }

  const rows = await env.DB
    .prepare(
      `SELECT r.id, r.name, r.status, r.max_players, r.host_id, u.display_name AS host_name,
              r.invite_code,
              (r.password_hash IS NOT NULL) AS has_password,
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
  const rooms = (rows.results ?? []).map(r => ({ ...r, has_password: !!r.has_password }));
  return json({ rooms });
}

async function handleCreateRoom(req, env, session) {
  const body = await readJson(req);
  const rawName = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!rawName) return err(400, 'bad_request', 'room name required');
  if (rawName.length > 60) return err(400, 'bad_request', 'name too long');

  const maxPlayers = Number.isInteger(body?.max_players) ? body.max_players : 4;
  if (maxPlayers < 2 || maxPlayers > 8) return err(400, 'bad_request', 'max_players must be 2-8');

  // Optional room password — if set, joiners must provide it.
  let passwordHash = null;
  if (typeof body?.password === 'string' && body.password.length > 0) {
    if (body.password.length < 4) return err(400, 'bad_request', 'password must be at least 4 characters');
    if (body.password.length > 100) return err(400, 'bad_request', 'password too long');
    passwordHash = await hashPassword(body.password);
  }

  const id = newRoomId();
  const inviteCode = newInviteCode();
  const now = Date.now();

  await env.DB.batch([
    env.DB
      .prepare('INSERT INTO rooms (id, name, host_id, status, max_players, created_at, updated_at, invite_code, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, rawName, session.user_id, 'lobby', maxPlayers, now, now, inviteCode, passwordHash),
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

  return json({
    room: {
      id,
      name: rawName,
      host_id: session.user_id,
      status: 'lobby',
      max_players: maxPlayers,
      invite_code: inviteCode,
      has_password: !!passwordHash,
    },
  }, { status: 201 });
}

// DELETE /api/rooms/:roomId — only the host can delete a room. Cascades
// through FKs in D1 so room_members, games (and their dependents:
// game_factions, game_bodies, game_ships, game_settlements, treaties,
// senate_proposals, chronicle_entries, etc.) all go with it.
async function handleDeleteRoom(req, env, session, roomId) {
  if (!ROOM_ID_RE.test(roomId)) return err(400, 'bad_request', 'invalid room id');
  const room = await env.DB.prepare('SELECT id, host_id FROM rooms WHERE id = ?').bind(roomId).first();
  if (!room) return err(404, 'not_found', 'room not found');
  if (room.host_id !== session.user_id) return err(403, 'not_host', 'only the host can delete this room');

  await env.DB.prepare('DELETE FROM rooms WHERE id = ?').bind(roomId).run();
  // Best-effort: tell the Room DO to close any open sockets and forget itself.
  try {
    await roomStub(env, roomId).fetch('https://room/destroy', { method: 'POST' });
  } catch { /* DO eviction is fine */ }
  return json({ ok: true });
}

async function handleJoinRoom(req, env, session, roomId) {
  if (!ROOM_ID_RE.test(roomId)) return err(400, 'bad_request', 'invalid room id');
  const room = await env.DB
    .prepare('SELECT id, max_players, status, password_hash FROM rooms WHERE id = ?')
    .bind(roomId)
    .first();
  if (!room) return err(404, 'not_found', 'room not found');
  if (room.status === 'closed') return err(409, 'room_closed', 'room is closed');

  const already = await env.DB
    .prepare('SELECT 1 AS x FROM room_members WHERE room_id = ? AND user_id = ?')
    .bind(roomId, session.user_id)
    .first();

  // Password gate: only enforce for users not already in the room.
  if (!already && room.password_hash) {
    const body = await readJson(req);
    const supplied = typeof body?.password === 'string' ? body.password : '';
    if (!supplied) return err(401, 'password_required', 'room is password-protected');
    const ok = await verifyPassword(supplied, room.password_hash);
    if (!ok) return err(403, 'bad_password', 'incorrect password');
  }

  if (!already) {
    const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM room_members WHERE room_id = ?').bind(roomId).first();
    if ((count?.c ?? 0) >= room.max_players) return err(403, 'room_full', 'room is full');
    await env.DB
      .prepare('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)')
      .bind(roomId, session.user_id, Date.now())
      .run();
    await env.DB.prepare('UPDATE rooms SET updated_at = ? WHERE id = ?').bind(Date.now(), roomId).run();

    // Tell the Room DO about the new member immediately so its `members`
    // map matches D1. Without this the DO only learns about a member when
    // they open a WebSocket via /connect — and a joiner who closes the
    // tab before connecting drifts forever (D1 count > DO count).
    // Best-effort: a failure here doesn't roll back the D1 insert because
    // the lobby snapshot path now reads members from D1 directly, so the
    // user still appears in the lobby UI even if this call dropped.
    try {
      const userRow = await env.DB
        .prepare('SELECT display_name FROM users WHERE id = ?')
        .bind(session.user_id)
        .first();
      await roomStub(env, roomId).fetch('https://room/member-add', {
        method: 'POST',
        body: JSON.stringify({
          userId: session.user_id,
          displayName: userRow?.display_name ?? 'player',
        }),
      });
    } catch (e) {
      console.warn('handleJoinRoom: DO member-add dispatch failed', e);
    }
  }

  return json({ ok: true, room_id: roomId });
}

// Join by invite code — frontend-facing convenience that resolves the
// 8-char code to a room id and then runs the same join logic.
async function handleJoinByCode(req, env, session) {
  const body = await readJson(req);
  const code = typeof body?.code === 'string' ? body.code.trim().toUpperCase() : '';
  if (!code) return err(400, 'bad_request', 'invite code required');
  if (!/^[A-Z2-9]{8}$/.test(code)) return err(400, 'bad_request', 'invalid invite code format');
  const room = await env.DB.prepare('SELECT id FROM rooms WHERE invite_code = ?').bind(code).first();
  if (!room) return err(404, 'not_found', 'no room with that code');
  // Reuse the same join handler — re-stringify the body so password (if any)
  // is preserved in the inner readJson.
  const inner = new Request(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify({ password: body?.password }),
  });
  return handleJoinRoom(inner, env, session, room.id);
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
import * as trades  from './trades.js';
import * as state   from './state.js';
import * as actions from './actions.js';

const FEATURE_MODULES = [lobby, factions, messages, senate, trades, state, actions];

function matchPattern(pattern, pathname) {
  if (typeof pattern === 'string') {
    return pattern === pathname ? {} : null;
  }
  const m = pathname.match(pattern);
  if (!m) return null;
  // pct-decode named captures. The route patterns capture raw pathname
  // segments; without decoding, IDs containing `:` (game-namespaced
  // body/ship ids like `Reemucleoytj:s0_io_1`) arrive at handlers as
  // `Reemucleoytj%3As0_io_1` and fail the SHIP_ID_RE / BODY_ID_RE
  // checks (the % char isn't in those character classes). Decoding
  // here means each handler can ignore the encoding question.
  const groups = m.groups ?? { _match: m };
  if (m.groups) {
    const decoded = {};
    for (const [k, v] of Object.entries(m.groups)) {
      try { decoded[k] = typeof v === 'string' ? decodeURIComponent(v) : v; }
      catch { decoded[k] = v; }
    }
    return decoded;
  }
  return groups;
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

// Auto-migration: each fresh Worker isolate runs handleInit() once on its
// first /api/* request and caches the resulting Promise. Solves the trap
// where the deploy pipeline ships new worker code (including new migration
// SQL bundled into _migrations_bundle.js) but D1's schema stays at the
// previous version until someone manually curls /api/__init. Without this,
// every endpoint that touches a freshly-added column 500s until init runs.
//
// handleInit is idempotent (only runs migrations not already in _migrations)
// so calling it eagerly costs ~1 query against _migrations per isolate.
let _initPromise = null;
function ensureMigrated(env) {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      // handleInit returns a 500 RESPONSE (not a throw) when a
      // migration statement fails — e.g. "duplicate column name"
      // from a partial prior application. The previous wrapper
      // didn't check the response shape, so a failed migration
      // silently latched as "init done" and every subsequent
      // request hit unmigrated columns and 500'd. Now we inspect
      // the response body; if ok=false, treat as failure, clear
      // the latch so the next request retries.
      const res = await handleInit(null, env);
      if (res && typeof res.json === 'function') {
        try {
          // Clone before reading so we don't drain the body on the
          // caller (handleInit isn't called for its return value
          // anywhere else, but defensive).
          const body = await res.clone().json();
          if (body && body.ok === false) {
            _initPromise = null;
            console.error('ensureMigrated: handleInit returned ok=false', body);
          }
        } catch { /* not JSON, treat as success */ }
      }
    } catch (e) {
      _initPromise = null;
      console.error('ensureMigrated failed', e);
    }
  })();
  return _initPromise;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname.startsWith('/api/')) {
      // Skip the auto-init for /api/__init itself (avoid a recursive call)
      // and /api/_version (unauthenticated probe that shouldn't depend on D1).
      if (url.pathname !== '/api/__init' && url.pathname !== '/api/_version') {
        await ensureMigrated(env);
      }
      try {
        return await this._dispatch(req, env, url);
      } catch (e) {
        return json(
          { error: { code: 'worker_exception', message: String(e?.message || e), stack: String(e?.stack || '').slice(0, 1000) } },
          { status: 500 },
        );
      }
    }

    return env.ASSETS.fetch(req);
  },

  /**
   * Cron-driven tick advancer. Cloudflare DO `setAlarm` is supposed to
   * wake hibernating DOs but in practice we've seen long-idle games
   * stall overnight when nobody's polling /state. This wakes every
   * minute, scans active games whose next_tick_at has passed, and
   * pokes each one's Room DO via /tick-now. The DO itself decides
   * whether to actually fire (it bails if next_tick_at hasn't passed),
   * so this is safe to run aggressively.
   *
   * Wired up via `triggers.crons` in wrangler.jsonc.
   */
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        // Cron handler hits D1 directly, so it suffers the same
        // stale-schema risk as the request path. Apply migrations first.
        await ensureMigrated(env);
        const now = Date.now();
        // Active games that are due OR orphaned (NULL next_tick_at but
        // not turn-based — the latter happens when a game's tick state
        // got dropped, e.g. an old game that predates migration 0013).
        const due = await env.DB
          .prepare(
            `SELECT id FROM games
              WHERE status = 'active'
                AND (turn_based_enabled IS NULL OR turn_based_enabled = 0)
                AND (next_tick_at IS NULL OR next_tick_at <= ?)`,
          )
          .bind(now)
          .all();
        const rows = due.results ?? [];
        if (rows.length === 0) return;
        // Fan out to each due game's DO. Don't await sequentially —
        // pokes are best-effort; one slow DO shouldn't block the rest.
        await Promise.all(rows.map(async (r) => {
          try {
            const stub = env.ROOM.get(env.ROOM.idFromName(r.id));
            await stub.fetch('https://room/tick-now', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ force: false, gameId: r.id }),
            });
          } catch (e) {
            console.error(`cron tick poke failed for ${r.id}`, e);
          }
        }));
      } catch (e) {
        console.error('scheduled tick advancer failed', e);
      }
    })());
  },

  async _dispatch(req, env, url) {
      // Version probe — unauthenticated. Returns the git SHA + build time
      // the worker bundle was produced from, so a smoke test can answer
      // "is my latest fix actually deployed?" without needing to inspect
      // bundled JS.
      if (req.method === 'GET' && url.pathname === '/api/_version') {
        return json({ git_sha: GIT_SHA, built_at: BUILT_AT });
      }
      // one-shot bootstrap (idempotent; no-op once tables exist)
      if (req.method === 'POST' && url.pathname === '/api/__init') return handleInit(req, env);
      // unauthenticated routes
      if (req.method === 'POST' && url.pathname === '/api/auth/signup') return handleSignup(req, env);
      if (req.method === 'POST' && url.pathname === '/api/auth/login') return handleLogin(req, env);
      if (req.method === 'POST' && url.pathname === '/api/auth/google') return handleGoogleAuth(req, env);
      if (req.method === 'POST' && url.pathname === '/api/auth/logout') return handleLogout(req, env);
      if (req.method === 'GET'  && url.pathname === '/api/auth/me') return handleMe(req, env);
      // Public client config: the frontend pulls this at startup to decide
      // whether to render the "Sign in with Google" button. Returns the
      // public Google client_id (safe to expose — it's already in the JWT
      // audience) or null if the server isn't configured for OAuth yet.
      if (req.method === 'GET' && url.pathname === '/api/auth/config') {
        return json({ google_client_id: env.GOOGLE_CLIENT_ID ?? null });
      }

      // everything below requires a session
      const session = await currentSession(req, env);
      if (!session) return err(401, 'unauthenticated', 'sign in required');

      if (req.method === 'GET'  && url.pathname === '/api/rooms') return handleListRooms(req, env);
      if (req.method === 'POST' && url.pathname === '/api/rooms') return handleCreateRoom(req, env, session);
      if (req.method === 'POST' && url.pathname === '/api/rooms/join-by-code') return handleJoinByCode(req, env, session);
      if (req.method === 'GET'  && url.pathname === '/api/users/me/rooms') return handleListMyRooms(req, env, session);

      const joinMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/join$/);
      if (joinMatch && req.method === 'POST') return handleJoinRoom(req, env, session, joinMatch[1]);

      const snapMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)$/);
      if (snapMatch && req.method === 'GET') return handleRoomSnapshot(req, env, session, snapMatch[1]);
      if (snapMatch && req.method === 'DELETE') return handleDeleteRoom(req, env, session, snapMatch[1]);

      const wsMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/ws$/);
      if (wsMatch) return handleRoomConnect(req, env, session, wsMatch[1]);

      // feature modules
      const featureResponse = await dispatchFeatureRoute(req, env, url, session);
      if (featureResponse) return featureResponse;

      return err(404, 'not_found', 'no such endpoint');
  },
};
