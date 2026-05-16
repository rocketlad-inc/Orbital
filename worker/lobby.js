// Lobby agent module.
//
// Owns: host controls (settings, kick, start), ready-check signaling helpers,
// and the lobby/start half of the start-game handshake.
//
// Contract with the Faction agent:
//   import { seedGameWorld } from './factions.js';
// After the lobby inserts the `games` row with status='setup', it calls
// `seedGameWorld(env, gameId)`. The Faction agent owns that export and is
// responsible for inserting `game_factions`, `game_bodies`, initial
// `sensor_coverage`, etc. We tolerate the export being missing (no-op import)
// during early development so the lobby can be exercised standalone.
import * as factions from './factions.js';

const ROOM_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;
// Match-length range (in ticks). 10,000 leaves room for multi-year
// epic campaigns even on long tick intervals; Earth->Neptune Hohmann is
// only ~410 ticks at base flight speeds.
const MATCH_LENGTH_MIN = 10;
const MATCH_LENGTH_MAX = 10_000;

// Whitelist of tick intervals (real-world ms between automatic ticks).
//   30s / 60s          — demo / live testing
//   5min / 30min       — quick lunch-break or evening-session games
//   1h / 6h / 12h      — async play at various paces
//   24h                — design default ("one tick a day")
const ALLOWED_TICK_INTERVALS = new Set([
  30_000,
  60_000,
  300_000,
  1_800_000,
  3_600_000,
  21_600_000,
  43_200_000,
  86_400_000,
]);

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
function roomStub(env, roomId) {
  return env.ROOM.get(env.ROOM.idFromName(roomId));
}

// ---------- shared helpers (exported for other agents) ----------

/**
 * Resolve a room and confirm the current session owns it.
 * Returns { room } on success or a Response on failure (caller should return it).
 */
export async function requireHost(env, roomId, session) {
  if (!ROOM_ID_RE.test(roomId)) return { error: err(400, 'bad_request', 'invalid room id') };
  const room = await env.DB
    .prepare('SELECT id, name, host_id, status, max_players FROM rooms WHERE id = ?')
    .bind(roomId)
    .first();
  if (!room) return { error: err(404, 'not_found', 'room not found') };
  if (room.host_id !== session.user_id) return { error: err(403, 'not_host', 'only the host can do that') };
  return { room };
}

// ---------- handlers ----------

async function loadRoomSettings(env, roomId) {
  // Settings live partly on the rooms row and partly in a small JSON blob
  // hosted in the Room DO. We surface a flat object for the UI.
  const room = await env.DB
    .prepare('SELECT id, name, host_id, status, max_players, invite_code, password_hash FROM rooms WHERE id = ?')
    .bind(roomId)
    .first();
  if (!room) return null;
  const game = await env.DB
    .prepare('SELECT id, status, current_tick, total_tick_target, tick_interval_ms, started_at FROM games WHERE id = ?')
    .bind(roomId)
    .first();
  // Pull pre-start config (total_tick_target, tick_interval_ms) from the DO
  // so the host can edit it before a games row exists.
  const cfgRes = await roomStub(env, roomId).fetch('https://room/settings');
  const cfg = cfgRes.ok ? await cfgRes.json() : {};
  return {
    id: room.id,
    name: room.name,
    host_id: room.host_id,
    status: room.status,
    max_players: room.max_players,
    invite_code: room.invite_code ?? null,
    has_password: !!room.password_hash,
    total_tick_target: game?.total_tick_target ?? cfg.total_tick_target ?? 42,
    tick_interval_ms: game?.tick_interval_ms ?? cfg.tick_interval_ms ?? 86_400_000,
    game_id: game?.id ?? null,
    game_status: game?.status ?? null,
    game_started_at: game?.started_at ?? null,
    current_tick: game?.current_tick ?? null,
  };
}

async function handleGetSettings(_req, env, ctx) {
  const roomId = ctx.params.roomId;
  const g = await requireHost(env, roomId, ctx.session);
  // GET settings is allowed for any member; reuse the room load but skip the host check.
  if (g.error && g.error.status !== 403) return g.error;
  const member = await env.DB
    .prepare('SELECT 1 AS x FROM room_members WHERE room_id = ? AND user_id = ?')
    .bind(roomId, ctx.session.user_id)
    .first();
  if (!member) return err(403, 'not_member', 'not a member of this room');
  const settings = await loadRoomSettings(env, roomId);
  if (!settings) return err(404, 'not_found', 'room not found');
  return json({ settings });
}

async function handleUpdateSettings(req, env, ctx) {
  const roomId = ctx.params.roomId;
  const g = await requireHost(env, roomId, ctx.session);
  if (g.error) return g.error;
  const { room } = g;
  const body = await readJson(req);
  if (!body || typeof body !== 'object') return err(400, 'bad_request', 'invalid body');

  // A game already exists: settings are frozen.
  const existing = await env.DB.prepare('SELECT 1 AS x FROM games WHERE id = ?').bind(roomId).first();
  if (existing) return err(409, 'already_started', 'settings are locked once the game has started');

  const updates = {};
  if (body.name != null) {
    if (typeof body.name !== 'string') return err(400, 'bad_request', 'name must be a string');
    const name = body.name.trim();
    if (!name) return err(400, 'bad_request', 'name required');
    if (name.length > 60) return err(400, 'bad_request', 'name too long');
    updates.name = name;
  }
  if (body.max_players != null) {
    if (!Number.isInteger(body.max_players) || body.max_players < 2 || body.max_players > 8) {
      return err(400, 'bad_request', 'max_players must be an integer 2-8');
    }
    const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM room_members WHERE room_id = ?').bind(roomId).first();
    if ((count?.c ?? 0) > body.max_players) {
      return err(409, 'too_many_members', 'reduce member count before lowering max_players');
    }
    updates.max_players = body.max_players;
  }
  let totalTickTarget = null, tickIntervalMs = null;
  if (body.total_tick_target != null) {
    if (!Number.isInteger(body.total_tick_target) || body.total_tick_target < MATCH_LENGTH_MIN || body.total_tick_target > MATCH_LENGTH_MAX) {
      return err(400, 'bad_request', `total_tick_target must be an integer ${MATCH_LENGTH_MIN}-${MATCH_LENGTH_MAX}`);
    }
    totalTickTarget = body.total_tick_target;
  }
  if (body.tick_interval_ms != null) {
    if (!ALLOWED_TICK_INTERVALS.has(body.tick_interval_ms)) {
      return err(400, 'bad_request', 'tick_interval_ms must be 60000, 3600000, or 86400000');
    }
    tickIntervalMs = body.tick_interval_ms;
  }

  const now = Date.now();
  if (updates.name != null || updates.max_players != null) {
    const sets = [];
    const args = [];
    if (updates.name != null) { sets.push('name = ?'); args.push(updates.name); }
    if (updates.max_players != null) { sets.push('max_players = ?'); args.push(updates.max_players); }
    sets.push('updated_at = ?'); args.push(now);
    args.push(roomId);
    await env.DB.prepare(`UPDATE rooms SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
  }

  // Push pre-start tick config + name into the DO.
  await roomStub(env, roomId).fetch('https://room/settings', {
    method: 'POST',
    body: JSON.stringify({
      name: updates.name ?? undefined,
      maxPlayers: updates.max_players ?? undefined,
      total_tick_target: totalTickTarget ?? undefined,
      tick_interval_ms: tickIntervalMs ?? undefined,
    }),
  });

  const settings = await loadRoomSettings(env, roomId);
  return json({ settings });
}

async function handleKick(req, env, ctx) {
  const roomId = ctx.params.roomId;
  const g = await requireHost(env, roomId, ctx.session);
  if (g.error) return g.error;
  const body = await readJson(req);
  const targetId = typeof body?.user_id === 'string' ? body.user_id : null;
  if (!targetId) return err(400, 'bad_request', 'user_id required');
  if (targetId === ctx.session.user_id) return err(400, 'bad_request', 'host cannot kick themselves');

  const existing = await env.DB.prepare('SELECT 1 AS x FROM games WHERE id = ?').bind(roomId).first();
  if (existing) return err(409, 'already_started', 'cannot kick after game has started');

  const res = await env.DB
    .prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ?')
    .bind(roomId, targetId)
    .run();
  if (!res.meta?.changes) return err(404, 'not_member', 'user is not a member');
  await env.DB.prepare('UPDATE rooms SET updated_at = ? WHERE id = ?').bind(Date.now(), roomId).run();

  await roomStub(env, roomId).fetch('https://room/kick', {
    method: 'POST',
    body: JSON.stringify({ userId: targetId }),
  });

  return json({ ok: true });
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function handleStart(_req, env, ctx) {
  const roomId = ctx.params.roomId;
  const g = await requireHost(env, roomId, ctx.session);
  if (g.error) return g.error;

  const existing = await env.DB.prepare('SELECT 1 AS x FROM games WHERE id = ?').bind(roomId).first();
  if (existing) return err(409, 'already_started', 'game already started');

  const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM room_members WHERE room_id = ?').bind(roomId).first();
  if ((count?.c ?? 0) < 2) return err(409, 'too_few_players', 'need at least 2 players to start');

  // Pull configured tick settings from the DO (the host may have edited them).
  let total_tick_target = 42;
  let tick_interval_ms = 86_400_000;
  try {
    const cfgRes = await roomStub(env, roomId).fetch('https://room/settings');
    if (cfgRes.ok) {
      const cfg = await cfgRes.json();
      if (Number.isInteger(cfg.total_tick_target)) total_tick_target = cfg.total_tick_target;
      if (ALLOWED_TICK_INTERVALS.has(cfg.tick_interval_ms)) tick_interval_ms = cfg.tick_interval_ms;
    }
  } catch {}

  const map_seed = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const now = Date.now();

  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO games (id, status, map_seed, current_tick, total_tick_target, tick_interval_ms, created_at, started_at)
         VALUES (?, 'setup', ?, 0, ?, ?, ?, ?)`,
      )
      .bind(roomId, map_seed, total_tick_target, tick_interval_ms, now, now),
    env.DB
      .prepare("UPDATE rooms SET status = 'in_progress', updated_at = ? WHERE id = ?")
      .bind(now, roomId),
  ]);

  // Hand off to the Faction agent. The export may not yet exist while that
  // agent is mid-development; we treat undefined as a no-op so the lobby
  // half of the handshake can be exercised in isolation.
  try {
    if (typeof factions.seedGameWorld === 'function') {
      await factions.seedGameWorld(env, roomId);
    }
  } catch (e) {
    // Best-effort: surface in logs but don't unwind the start; the Faction
    // agent's seeding is expected to be idempotent and retryable.
    console.error('seedGameWorld failed', e);
  }

  await roomStub(env, roomId).fetch('https://room/game-started', {
    method: 'POST',
    body: JSON.stringify({ gameId: roomId, total_tick_target, tick_interval_ms, started_at: now }),
  });

  const settings = await loadRoomSettings(env, roomId);
  return json({ ok: true, settings });
}

// Extended listing: like /api/rooms but with host_id, settings, ready counts,
// and game_id when started. We add this alongside the worker's existing list
// rather than modify worker.js (which is owned by another agent).
async function handleListLobbyRooms(_req, env, _ctx) {
  const rows = await env.DB
    .prepare(
      `SELECT r.id, r.name, r.status, r.max_players, r.host_id, r.created_at, r.updated_at,
              u.display_name AS host_name,
              (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) AS member_count,
              g.id AS game_id, g.status AS game_status,
              g.total_tick_target, g.tick_interval_ms, g.started_at
       FROM rooms r
       JOIN users u ON u.id = r.host_id
       LEFT JOIN games g ON g.id = r.id
       WHERE r.status != 'closed'
       ORDER BY r.updated_at DESC
       LIMIT 50`,
    )
    .all();

  // For unstarted rooms, fetch DO-side config in parallel so the UI can show
  // tick-target / interval even before the game is created.
  const out = [];
  for (const r of rows.results ?? []) {
    let total_tick_target = r.total_tick_target ?? null;
    let tick_interval_ms = r.tick_interval_ms ?? null;
    if (!r.game_id) {
      try {
        const cfgRes = await roomStub(env, r.id).fetch('https://room/settings');
        if (cfgRes.ok) {
          const cfg = await cfgRes.json();
          total_tick_target = cfg.total_tick_target ?? total_tick_target;
          tick_interval_ms = cfg.tick_interval_ms ?? tick_interval_ms;
        }
      } catch {}
    }
    out.push({ ...r, total_tick_target, tick_interval_ms });
  }
  return json({ rooms: out });
}

// Per-room extended snapshot. Wraps the DO snapshot and adds DB-side context.
async function handleLobbySnapshot(_req, env, ctx) {
  const roomId = ctx.params.roomId;
  const member = await env.DB
    .prepare('SELECT 1 AS x FROM room_members WHERE room_id = ? AND user_id = ?')
    .bind(roomId, ctx.session.user_id)
    .first();
  if (!member) return err(403, 'not_member', 'not a member of this room');

  const settings = await loadRoomSettings(env, roomId);
  if (!settings) return err(404, 'not_found', 'room not found');
  const snapRes = await roomStub(env, roomId).fetch('https://room/snapshot');
  const snap = snapRes.ok ? await snapRes.json() : { members: [], connected: [], ready: {} };

  // Enrich the DO member list with the empire identity recorded in D1.
  const idRows = await env.DB
    .prepare('SELECT user_id, empire_name, bio, chosen_starting_body FROM room_members WHERE room_id = ?')
    .bind(roomId)
    .all();
  const identityByUser = new Map(
    (idRows.results ?? []).map(r => [r.user_id, {
      empire_name: r.empire_name,
      bio: r.bio,
      chosen_starting_body: r.chosen_starting_body,
    }]),
  );
  const enrichedMembers = (snap.members ?? []).map(m => ({
    ...m,
    empire_name: identityByUser.get(m.userId)?.empire_name ?? null,
    bio: identityByUser.get(m.userId)?.bio ?? null,
    chosen_starting_body: identityByUser.get(m.userId)?.chosen_starting_body ?? null,
  }));

  return json({
    settings,
    members: enrichedMembers,
    connected: snap.connected ?? [],
    ready: snap.ready ?? {},
    game_started: settings.game_id != null,
    game_id: settings.game_id,
    // Catalog of bodies players can pick as their capital. Currently
    // every terrestrial planet plus the larger moons.
    starting_body_options: factions.STARTING_BODY_OPTIONS,
  });
}

// PATCH /api/lobby/rooms/:roomId/me — caller updates their own empire identity.
// Locked once the game has started (so post-start changes go through the
// Faction agent's PATCH /api/games/:gameId/factions/me instead).
async function handlePatchMe(req, env, ctx) {
  const roomId = ctx.params.roomId;
  if (!ROOM_ID_RE.test(roomId)) return err(400, 'bad_request', 'invalid room id');

  const member = await env.DB
    .prepare('SELECT 1 AS x FROM room_members WHERE room_id = ? AND user_id = ?')
    .bind(roomId, ctx.session.user_id)
    .first();
  if (!member) return err(403, 'not_member', 'not a member of this room');

  const started = await env.DB.prepare('SELECT 1 AS x FROM games WHERE id = ?').bind(roomId).first();
  if (started) return err(409, 'already_started', 'lobby identity locked once the game has started');

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return err(400, 'bad_request', 'invalid body');

  const sets = [];
  const args = [];
  if (body.empire_name !== undefined) {
    if (body.empire_name === null || body.empire_name === '') {
      sets.push('empire_name = NULL');
    } else {
      if (typeof body.empire_name !== 'string') return err(400, 'bad_request', 'empire_name must be a string');
      const trimmed = body.empire_name.trim();
      if (trimmed.length < 1 || trimmed.length > 40) return err(400, 'bad_request', 'empire_name must be 1-40 characters');
      sets.push('empire_name = ?');
      args.push(trimmed);
    }
  }
  if (body.bio !== undefined) {
    if (body.bio === null || body.bio === '') {
      sets.push('bio = NULL');
    } else {
      if (typeof body.bio !== 'string') return err(400, 'bad_request', 'bio must be a string');
      const trimmed = body.bio.trim();
      if (trimmed.length > 1000) return err(400, 'bad_request', 'bio must be <= 1000 characters');
      sets.push('bio = ?');
      args.push(trimmed);
    }
  }
  if (body.chosen_starting_body !== undefined) {
    if (body.chosen_starting_body === null || body.chosen_starting_body === '') {
      sets.push('chosen_starting_body = NULL');
    } else {
      if (!factions.isValidStartingBody(body.chosen_starting_body)) {
        return err(400, 'bad_request', 'invalid starting body');
      }
      // Reject if another member of this room already claimed it.
      const taken = await env.DB
        .prepare('SELECT 1 AS x FROM room_members WHERE room_id = ? AND chosen_starting_body = ? AND user_id != ?')
        .bind(roomId, body.chosen_starting_body, ctx.session.user_id)
        .first();
      if (taken) return err(409, 'body_taken', 'another player already chose that body');
      sets.push('chosen_starting_body = ?');
      args.push(body.chosen_starting_body);
    }
  }
  if (!sets.length) return err(400, 'bad_request', 'nothing to update');

  args.push(roomId, ctx.session.user_id);
  await env.DB
    .prepare(`UPDATE room_members SET ${sets.join(', ')} WHERE room_id = ? AND user_id = ?`)
    .bind(...args)
    .run();

  const row = await env.DB
    .prepare('SELECT empire_name, bio, chosen_starting_body FROM room_members WHERE room_id = ? AND user_id = ?')
    .bind(roomId, ctx.session.user_id)
    .first();
  return json({ identity: row });
}

// POST /api/lobby/rooms/:roomId/force-tick — host-only manual tick. Useful
// when a Cloudflare alarm has stalled, or when the host wants to fast-
// forward a game (e.g. demos, debugging). Bypasses the next_tick_at gate
// by passing { force: true } to the Room DO.
async function handleForceTick(_req, env, ctx) {
  const roomId = ctx.params.roomId;
  const g = await requireHost(env, roomId, ctx.session);
  if (g.error) return g.error;
  const game = await env.DB
    .prepare('SELECT id, status, current_tick, next_tick_at FROM games WHERE id = ?')
    .bind(roomId).first();
  if (!game) return err(404, 'not_found', 'no game in this room yet');
  if (game.status !== 'active') return err(409, 'not_active', `game is ${game.status}`);

  // Self-heal: if BODY_CATALOG has gained bodies since this game was
  // seeded (asteroid belt, Kuiper objects, new moons), insert the
  // missing rows now so the host doesn't have to start a fresh game
  // just to see them. Idempotent — existing bodies are skipped.
  let bodiesAdded = 0;
  try {
    if (typeof factions.backfillMissingBodies === 'function') {
      bodiesAdded = await factions.backfillMissingBodies(env, roomId);
    }
  } catch (e) {
    console.error('backfillMissingBodies failed', e);
  }

  try {
    // Pass gameId in the body so the DO can self-heal its `gameStarted`
    // storage if it was recycled or never received /game-started.
    const r = await roomStub(env, roomId).fetch('https://room/tick-now', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true, gameId: roomId }),
    });
    if (!r.ok && r.status !== 204) {
      const text = await r.text().catch(() => '');
      return err(r.status || 500, 'tick_failed', text || `room responded ${r.status}`);
    }
  } catch (e) {
    return err(500, 'tick_failed', String(e?.message || e));
  }
  // Read back the new tick so the host UI can show what actually moved.
  const after = await env.DB
    .prepare('SELECT current_tick, next_tick_at FROM games WHERE id = ?')
    .bind(roomId).first();
  return json({
    ok: true,
    current_tick: after?.current_tick ?? game.current_tick,
    next_tick_at: after?.next_tick_at ?? game.next_tick_at,
    advanced: (after?.current_tick ?? 0) > (game.current_tick ?? 0),
    bodies_added: bodiesAdded,
    tick_interval_ms: game.tick_interval_ms ?? null,
  });
}

/**
 * PATCH /api/lobby/rooms/:roomId/tick-interval — host-only. Change the
 * tick cadence of an already-started game. Re-arms next_tick_at to
 * Date.now() + new_interval so the next tick fires according to the
 * new pace rather than the one set at start.
 *
 * Body: { tick_interval_ms: number }   (must be in ALLOWED_TICK_INTERVALS)
 */
async function handleChangeTickInterval(req, env, ctx) {
  const roomId = ctx.params.roomId;
  const g = await requireHost(env, roomId, ctx.session);
  if (g.error) return g.error;
  let body;
  try { body = await req.json(); } catch { return err(400, 'bad_request', 'invalid json'); }
  const newInterval = body?.tick_interval_ms;
  if (!Number.isInteger(newInterval) || !ALLOWED_TICK_INTERVALS.has(newInterval)) {
    return err(400, 'bad_request', `tick_interval_ms must be one of ${[...ALLOWED_TICK_INTERVALS].join(', ')}`);
  }
  const game = await env.DB
    .prepare('SELECT id, status FROM games WHERE id = ?')
    .bind(roomId).first();
  if (!game) return err(404, 'not_found', 'no game in this room yet');
  if (game.status !== 'active') return err(409, 'not_active', `game is ${game.status}`);

  const nextAt = Date.now() + newInterval;
  await env.DB
    .prepare('UPDATE games SET tick_interval_ms = ?, next_tick_at = ? WHERE id = ?')
    .bind(newInterval, nextAt, roomId)
    .run();
  // The cron-driven scheduled handler in worker/index.js picks up the new
  // next_tick_at within ~1 minute, so we don't need to round-trip the DO
  // to re-arm. The DO's own alarm will be re-armed naturally on its next
  // tick fire.
  return json({ ok: true, tick_interval_ms: newInterval, next_tick_at: nextAt });
}

/**
 * PATCH /api/lobby/rooms/:roomId/match-length — host-only. Extend (or
 * shrink, with safety) the total_tick_target of an in-flight game.
 * Mostly used to keep a playtest going past the 42-tick default
 * without having to restart. Server only accepts values strictly
 * greater than current_tick so the host can't accidentally instant-
 * end the game by setting it below the present.
 *
 * Body: { total_tick_target: number }   (10..10000, must be > current_tick)
 */
async function handleChangeMatchLength(req, env, ctx) {
  const roomId = ctx.params.roomId;
  const g = await requireHost(env, roomId, ctx.session);
  if (g.error) return g.error;
  let body;
  try { body = await req.json(); } catch { return err(400, 'bad_request', 'invalid json'); }
  const newTotal = body?.total_tick_target;
  if (!Number.isInteger(newTotal) || newTotal < MATCH_LENGTH_MIN || newTotal > MATCH_LENGTH_MAX) {
    return err(400, 'bad_request', `total_tick_target must be an integer ${MATCH_LENGTH_MIN}-${MATCH_LENGTH_MAX}`);
  }
  const game = await env.DB
    .prepare('SELECT id, status, current_tick FROM games WHERE id = ?')
    .bind(roomId).first();
  if (!game) return err(404, 'not_found', 'no game in this room yet');
  if (game.status !== 'active') return err(409, 'not_active', `game is ${game.status}`);
  if (newTotal <= (game.current_tick ?? 0)) {
    return err(400, 'bad_request', `total_tick_target must be greater than current tick (${game.current_tick})`);
  }
  await env.DB
    .prepare('UPDATE games SET total_tick_target = ? WHERE id = ?')
    .bind(newTotal, roomId)
    .run();
  return json({ ok: true, total_tick_target: newTotal, current_tick: game.current_tick });
}

export const routes = [
  { method: 'GET',  pattern: '/api/lobby/rooms', auth: 'required', handle: handleListLobbyRooms },
  { method: 'GET',  pattern: /^\/api\/lobby\/rooms\/(?<roomId>[^/]+)$/, auth: 'required', handle: handleLobbySnapshot },
  { method: 'GET',  pattern: /^\/api\/lobby\/rooms\/(?<roomId>[^/]+)\/settings$/, auth: 'required', handle: handleGetSettings },
  { method: 'PATCH',pattern: /^\/api\/lobby\/rooms\/(?<roomId>[^/]+)\/settings$/, auth: 'required', handle: handleUpdateSettings },
  { method: 'POST', pattern: /^\/api\/lobby\/rooms\/(?<roomId>[^/]+)\/kick$/, auth: 'required', handle: handleKick },
  { method: 'POST', pattern: /^\/api\/lobby\/rooms\/(?<roomId>[^/]+)\/start$/, auth: 'required', handle: handleStart },
  { method: 'POST', pattern: /^\/api\/lobby\/rooms\/(?<roomId>[^/]+)\/force-tick$/, auth: 'required', handle: handleForceTick },
  { method: 'PATCH',pattern: /^\/api\/lobby\/rooms\/(?<roomId>[^/]+)\/tick-interval$/, auth: 'required', handle: handleChangeTickInterval },
  { method: 'PATCH',pattern: /^\/api\/lobby\/rooms\/(?<roomId>[^/]+)\/match-length$/, auth: 'required', handle: handleChangeMatchLength },
  { method: 'PATCH',pattern: /^\/api\/lobby\/rooms\/(?<roomId>[^/]+)\/me$/, auth: 'required', handle: handlePatchMe },
];
