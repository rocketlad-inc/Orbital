// ============================================================
// Solo games — single player, as a solo multiplayer room.
//
// Lorne, 2026-10-23: "it might be time to bring back single player". The
// old client-side single player stays dead. A solo game is an ordinary
// multiplayer game on the same server and rules, with one person seated
// beside 1-5 computer empires that act through the real game actions
// (worker/aiEmpire.js), paying the same costs and getting the same
// refusals. No cheating.
//
// His picks (2026-10-23):
//   - speeds 30 s / 2 min / 10 min a tick, and the player can PAUSE;
//   - 1-5 rivals, 3 by default;
//   - difficulty peaceful / normal / ruthless (how soon and how hard the
//     computer empires go to war; never extra resources);
//   - victory exactly as in multiplayer.
//
// The computer empires are agent users (auth.js getOrCreateAgentUser),
// the same accounts the Studio seats: mail, analytics and win-back
// already ignore them. A pool of five is reused across every solo game,
// since a seat only has to be unique within one game. What marks a
// faction as a computer empire is game_factions.ai_doctrine (0181).
//
// Routes:
//   POST  /api/solo                       { rivals, difficulty, speed_ms }
//   POST  /api/games/:gameId/solo/pause
//   POST  /api/games/:gameId/solo/resume
//   POST  /api/games/:gameId/solo/step    one tick while paused
//   PATCH /api/games/:gameId/solo/speed   { speed_ms }
// ============================================================

import { getOrCreateAgentUser } from './auth.js';
import { startGame } from './lobby.js';
import { runSoloGame } from './aiEmpire.js';

const json = (data, init = {}) => new Response(JSON.stringify(data), {
  ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
});
const err = (status, code, message) => json({ error: { code, message } }, { status });
async function readJson(req) { try { return await req.json(); } catch { return null; } }
const roomStub = (env, id) => env.ROOM.get(env.ROOM.idFromName(id));
const GAME_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;

/** His speeds: Fast, Steady, Relaxed. */
export const SOLO_SPEEDS = [30_000, 120_000, 600_000];
export const SOLO_DEFAULT_SPEED = 120_000;
export const SOLO_DIFFICULTIES = ['peaceful', 'normal', 'ruthless'];
export const SOLO_MAX_RIVALS = 5;
export const SOLO_DEFAULT_RIVALS = 3;

/** Which strategies a difficulty deals, seat by seat. A peaceful system
 *  has no warmongers; a ruthless one is mostly them. The doctrines are
 *  aiEmpire.js's. */
const DOCTRINE_DECKS = {
  peaceful: ['expander', 'economist', 'technocrat', 'expander', 'economist'],
  normal: ['expander', 'rusher', 'economist', 'technocrat', 'expander'],
  ruthless: ['rusher', 'expander', 'rusher', 'technocrat', 'rusher'],
};

function newRoomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The pool of computer players, made on first use. */
async function aiUsers(env, n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const u = await getOrCreateAgentUser(env.DB, `solo-ai-${i}`);
    // Anywhere a person's name would show, a computer empire reads as one.
    if (String(u.display_name ?? '').startsWith('[agent]')) {
      await env.DB.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind('Computer', u.id).run();
      u.display_name = 'Computer';
    }
    out.push(u);
  }
  return out;
}

// POST /api/solo
async function handleCreate(req, env, ctx) {
  const userId = ctx.session.user_id;
  const body = (await readJson(req)) ?? {};
  const rivals = Math.max(1, Math.min(SOLO_MAX_RIVALS, Math.floor(Number(body.rivals ?? SOLO_DEFAULT_RIVALS)) || SOLO_DEFAULT_RIVALS));
  const difficulty = SOLO_DIFFICULTIES.includes(body.difficulty) ? body.difficulty : 'normal';
  const speed = SOLO_SPEEDS.includes(Number(body.speed_ms)) ? Number(body.speed_ms) : SOLO_DEFAULT_SPEED;

  const me = await env.DB.prepare('SELECT id, display_name FROM users WHERE id = ?').bind(userId).first();
  if (!me) return err(401, 'unauthenticated', 'sign in required');
  const bots = await aiUsers(env, rivals);

  const id = newRoomId();
  const now = Date.now();
  const name = `Solo · ${String(me.display_name ?? 'Commander').slice(0, 40)}`.slice(0, 60);
  const seats = [{ id: me.id, display_name: me.display_name }, ...bots];
  // A password nobody can type keeps the room out of every join path
  // (Quick Join only offers password-free rooms), and NO invite code: a
  // code skips the password (invites.js), and the in-game Invite button
  // only shows when there is one. The listings skip solo games by flag.
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO rooms (id, name, host_id, status, max_players, created_at, updated_at, invite_code, password_hash, quick_join)
                    VALUES (?, ?, ?, 'lobby', ?, ?, ?, NULL, ?, 0)`)
      .bind(id, name, me.id, seats.length, now, now, 'solo:no-entry'),
    ...seats.map((u, i) => env.DB
      .prepare("INSERT INTO room_members (room_id, user_id, joined_at, join_method) VALUES (?, ?, ?, ?)")
      .bind(id, u.id, now + i, i === 0 ? 'host' : 'solo_ai')),
  ]);
  await roomStub(env, id).fetch('https://room/init', {
    method: 'POST',
    body: JSON.stringify({
      meta: { id, name, hostId: me.id, status: 'lobby', maxPlayers: seats.length, createdAt: now },
      members: Object.fromEntries(seats.map(u => [u.id, { userId: u.id, displayName: u.display_name }])),
    }),
  });
  const started = await startGame(env, id, { solo: { difficulty, tickIntervalMs: speed } });
  if (started.error) return started.error;

  // Deal the strategies, seat by seat after the player's.
  const deck = DOCTRINE_DECKS[difficulty];
  await env.DB.batch(bots.map((u, i) => env.DB
    .prepare('UPDATE game_factions SET ai_doctrine = ? WHERE game_id = ? AND user_id = ?')
    .bind(deck[i % deck.length], id, u.id)));
  return json({ ok: true, game_id: id, rivals, difficulty, speed_ms: speed });
}

/** The caller's solo game, or an error. Only its one person may drive the
 *  clock. */
async function loadSolo(env, ctx) {
  const gameId = ctx.params.gameId;
  if (!GAME_ID_RE.test(gameId)) return { error: err(400, 'bad_request', 'invalid game id') };
  const row = await env.DB
    .prepare(`SELECT g.id, g.status, g.solo, g.paused, g.tick_interval_ms, r.host_id
                FROM games g JOIN rooms r ON r.id = g.id WHERE g.id = ?`)
    .bind(gameId).first();
  if (!row) return { error: err(404, 'not_found', 'no such game') };
  if (Number(row.solo) !== 1) return { error: err(409, 'not_solo', 'only a solo game can be paused') };
  if (row.host_id !== ctx.session.user_id) return { error: err(403, 'not_yours', 'not your game') };
  if (row.status !== 'active') return { error: err(409, 'not_active', 'this game is not running') };
  return { game: row };
}

async function rearm(env, gameId) {
  try {
    await roomStub(env, gameId).fetch('https://room/rearm', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gameId }),
    });
  } catch (e) { console.error('solo rearm failed', e); }
}

// POST /api/games/:gameId/solo/pause
async function handlePause(_req, env, ctx) {
  const L = await loadSolo(env, ctx);
  if (L.error) return L.error;
  // next_tick_at NULL: the clock reads as stopped everywhere (the map's
  // tick glide holds still on it). room.js, the cron and /state all leave
  // a paused game alone.
  await env.DB.prepare('UPDATE games SET paused = 1, next_tick_at = NULL, state_version = state_version + 1 WHERE id = ?')
    .bind(L.game.id).run();
  return json({ ok: true, paused: true });
}

// POST /api/games/:gameId/solo/resume
async function handleResume(_req, env, ctx) {
  const L = await loadSolo(env, ctx);
  if (L.error) return L.error;
  const next = Date.now() + Number(L.game.tick_interval_ms || SOLO_DEFAULT_SPEED);
  await env.DB.prepare('UPDATE games SET paused = 0, next_tick_at = ?, state_version = state_version + 1 WHERE id = ?')
    .bind(next, L.game.id).run();
  await rearm(env, L.game.id);
  return json({ ok: true, paused: false, next_tick_at: next });
}

// POST /api/games/:gameId/solo/step — one tick while paused.
async function handleStep(_req, env, ctx) {
  const L = await loadSolo(env, ctx);
  if (L.error) return L.error;
  if (Number(L.game.paused) !== 1) return err(409, 'not_paused', 'pause the game to step it');
  const res = await roomStub(env, L.game.id).fetch('https://room/tick-now', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ force: true, gameId: L.game.id }),
  });
  if (!res.ok) return err(502, 'step_failed', 'the tick did not run');
  // The computer empires answer the step at once rather than at the next
  // cron minute: a player stepping through a fight wants them to move.
  try { await runSoloGame(env, L.game.id); } catch (e) { console.error('solo step turns failed', e); }
  await env.DB.prepare('UPDATE games SET state_version = state_version + 1 WHERE id = ?').bind(L.game.id).run();
  const row = await env.DB.prepare('SELECT current_tick FROM games WHERE id = ?').bind(L.game.id).first();
  return json({ ok: true, tick: row?.current_tick ?? null });
}

// PATCH /api/games/:gameId/solo/speed
async function handleSpeed(req, env, ctx) {
  const L = await loadSolo(env, ctx);
  if (L.error) return L.error;
  const body = (await readJson(req)) ?? {};
  const speed = Number(body.speed_ms);
  if (!SOLO_SPEEDS.includes(speed)) return err(400, 'bad_speed', 'speed must be 30 s, 2 min or 10 min');
  const paused = Number(L.game.paused) === 1;
  const next = paused ? null : Date.now() + speed;
  await env.DB.prepare(`UPDATE games SET tick_interval_ms = ?, tick_schedule = NULL, next_tick_at = ?,
                               state_version = state_version + 1 WHERE id = ?`)
    .bind(speed, next, L.game.id).run();
  if (!paused) await rearm(env, L.game.id);
  return json({ ok: true, speed_ms: speed, next_tick_at: next });
}

export const routes = [
  { method: 'POST', pattern: '/api/solo', auth: 'required', handle: handleCreate },
  { method: 'POST', pattern: /^\/api\/games\/(?<gameId>[^/]+)\/solo\/pause$/, auth: 'required', handle: handlePause },
  { method: 'POST', pattern: /^\/api\/games\/(?<gameId>[^/]+)\/solo\/resume$/, auth: 'required', handle: handleResume },
  { method: 'POST', pattern: /^\/api\/games\/(?<gameId>[^/]+)\/solo\/step$/, auth: 'required', handle: handleStep },
  { method: 'PATCH', pattern: /^\/api\/games\/(?<gameId>[^/]+)\/solo\/speed$/, auth: 'required', handle: handleSpeed },
];
