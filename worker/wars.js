// ============================================================================
// wars.js — who is allowed to shoot whom.
//
// THE INVERSION. This game used to have no war state at all. Hostility was
// the absence of a treaty, so `peacePairs` answered "who may NOT shoot" and
// everyone else could, from tick one. The commonest complaint about the
// game was that everyone starts at war, and they were right — they did,
// and the only way out was to negotiate a non-aggression pact as a term
// inside a trade deal, which needs a willing counterparty.
//
// Now the default is peace and `hostilePairs` answers "who MAY shoot": a
// pair is at war only while an open game_wars row says so. Peace is the
// absence of a row, which means it costs nothing, needs no counterparty,
// and is what a new game starts in.
//
// Endpoints:
//   GET  /api/games/:gameId/wars           — every war, open and historical
//   POST /api/games/:gameId/wars/declare   — { target_faction_id }
//   POST /api/games/:gameId/wars/end       — offer a ceasefire, or accept one
//   POST /api/games/:gameId/wars/end/undo  — withdraw an offer nobody took
//
// TAKES EFFECT IMMEDIATELY (Lorne). Declaring and firing in the same tick
// is allowed. The cost of a declaration is not a notice period — it is
// that it is PUBLIC and permanent in the record: a chronicle entry, the
// Herald, and an `origin` on the row saying whether you declared it or
// broke an oath to get it.
//
// PACTS STILL MEAN SOMETHING. They are now a promise not to declare rather
// than a shield against fire. Declaring on a pact partner is allowed and
// breaks the pact in the same action, stamping broken_at_tick and
// breaker_faction_id — the columns the treaties table has always carried
// for exactly this and nothing has ever written.
//
// WAR TAKES ONE. PEACE TAKES TWO (Lorne).
//
// The first cut let either side end a war alone, arguing that mutual
// consent would trap a loser in a war they could not leave. Wrong twice:
// being held in a war you are losing is the POINT — it is what gives
// peace a price and the winner something to negotiate for — and a
// unilateral exit made the declaration free. Declare, fire everything,
// stand down before the reply lands, repeat; never once a legal target
// yourself. Immediate effect only works as a rule if leaving costs
// something, and what it costs is the other side's agreement.
//
// Standing down is therefore an OFFER. One side proposes, the war runs
// on, and it ends the moment the other answers in kind. An offer can be
// withdrawn while it is unanswered, and does not expire: a standing
// offer is a standing willingness to stop, which is a true thing to
// advertise.
//
// A war still has no owner — declared_by is for blame and for the
// Herald, not for authority over how it ends.
// ============================================================================

import { json, err, readJson, newId, callerFaction, loadGame, notifyRoom } from './trades.js';

const GAME_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;

/** Unordered key for a faction pair. Every caller must agree on the
 *  ordering or half the lookups miss. Same shape as room.js's pairKey. */
export function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Normalised (a, b) for storage, so the partial unique index on open
 *  wars actually means "one open war per pair". */
function ordered(a, b) {
  return a < b ? [a, b] : [b, a];
}

/**
 * Faction pairs currently AT WAR, as `a|b` keys.
 *
 * The one source of truth for "will these two shoot" — the combat pass,
 * the targeting passes, flak, station guns, megastructure crowding and
 * the client's own predicate all read this. Peace is not represented
 * anywhere; it is what a missing key means.
 */
export async function hostilePairs(env, gameId) {
  const rows = (await env.DB
    .prepare(
      `SELECT faction_a, faction_b FROM game_wars
        WHERE game_id = ? AND ended_at_tick IS NULL`,
    )
    .bind(gameId)
    .all()).results ?? [];
  const out = new Set();
  for (const r of rows) out.add(pairKey(r.faction_a, r.faction_b));
  return out;
}

/** The open war row for a pair, or null. */
async function openWar(env, gameId, a, b) {
  const [x, y] = ordered(a, b);
  return env.DB
    .prepare(
      `SELECT * FROM game_wars
        WHERE game_id = ? AND faction_a = ? AND faction_b = ? AND ended_at_tick IS NULL`,
    )
    .bind(gameId, x, y)
    .first();
}

/**
 * Open a war. Shared by the endpoint and by the rollout seeder, so a
 * seeded war is the same row a declared one is — there is no second
 * shape for the tick to know about.
 *
 * Returns the row id, or null when one is already open.
 */
export async function openWarBetween(env, gameId, tick, declaredBy, other, origin) {
  if (await openWar(env, gameId, declaredBy, other)) return null;
  const [x, y] = ordered(declaredBy, other);
  const id = newId();
  await env.DB
    .prepare(
      `INSERT INTO game_wars
         (id, game_id, faction_a, faction_b, declared_by, declared_at_tick, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, gameId, x, y, declaredBy, tick, origin)
    .run();
  return id;
}

/**
 * Pacts that would be broken by declaring on this faction.
 *
 * A NAP or defence pact is a promise not to declare, so declaring
 * through one is an oath broken rather than a move blocked — the player
 * gets to do it, and the record says they did.
 */
async function pactsWith(env, gameId, me, other) {
  return (await env.DB
    .prepare(
      `SELECT t.id, t.kind FROM treaties t
        WHERE t.game_id = ? AND t.status = 'active' AND t.broken_at_tick IS NULL
          AND t.kind IN ('nap', 'defense_pact')
          AND EXISTS (SELECT 1 FROM treaty_signatories s
                       WHERE s.treaty_id = t.id AND s.faction_id = ? AND s.signed_at_tick IS NOT NULL)
          AND EXISTS (SELECT 1 FROM treaty_signatories s
                       WHERE s.treaty_id = t.id AND s.faction_id = ? AND s.signed_at_tick IS NOT NULL)`,
    )
    .bind(gameId, me, other)
    .all()).results ?? [];
}

async function chronicle(env, gameId, tick, kind, actor, target, payload) {
  await env.DB
    .prepare(
      `INSERT INTO chronicle_entries
         (id, game_id, tick_number, kind, actor_faction_id, target_faction_id, payload, visibility, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'public', ?)`,
    )
    .bind(newId(), gameId, tick, kind, actor, target, JSON.stringify(payload), Date.now())
    .run();
}

/** Both factions, or an error response. */
async function parties(env, gameId, session, body) {
  const me = await callerFaction(env, gameId, session.user_id);
  if (!me) return { error: err(403, 'forbidden', 'you hold no faction in this game') };
  const targetId = String(body?.target_faction_id ?? '');
  if (!targetId) return { error: err(400, 'bad_request', 'target_faction_id is required') };
  if (targetId === me.id) return { error: err(400, 'bad_request', 'you cannot declare war on yourself') };
  const them = await env.DB
    .prepare('SELECT id, name, status FROM game_factions WHERE game_id = ? AND id = ?')
    .bind(gameId, targetId)
    .first();
  if (!them) return { error: err(404, 'not_found', 'no such faction in this game') };
  return { me, them };
}

export async function handleDeclare(req, env, { session, params }) {
  const { gameId } = params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'bad game id');
  const game = await loadGame(env, gameId);
  if (!game) return err(404, 'not_found', 'no such game');
  const body = await readJson(req);
  const p = await parties(env, gameId, session, body);
  if (p.error) return p.error;
  const { me, them } = p;

  // ELIMINATED FACTIONS ARE NOT COMBATANTS. Keyed on the faction's own
  // in-game status, never on whether anyone has logged in lately.
  if (them.status === 'eliminated') {
    return err(409, 'conflict', `${them.name} has already been eliminated`);
  }
  if (await openWar(env, gameId, me.id, them.id)) {
    return err(409, 'already_at_war', `you are already at war with ${them.name}`);
  }

  const tick = game.current_tick ?? 0;
  const broken = await pactsWith(env, gameId, me.id, them.id);
  for (const t of broken) {
    await env.DB
      .prepare('UPDATE treaties SET status = \'broken\', broken_at_tick = ?, breaker_faction_id = ? WHERE id = ?')
      .bind(tick, me.id, t.id)
      .run();
  }
  const id = await openWarBetween(env, gameId, tick, me.id, them.id,
    broken.length ? 'pact_broken' : 'declared');

  await chronicle(env, gameId, tick, 'war_declared', me.id, them.id, {
    war_id: id, broke_pacts: broken.map(t => t.kind),
  });
  await notifyRoom(env, gameId, { type: 'wars_changed' });
  return json({
    ok: true, war_id: id, at_war_with: them.id,
    broke_pacts: broken.map(t => t.kind),
  });
}

export async function handleEnd(req, env, { session, params }) {
  const { gameId } = params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'bad game id');
  const game = await loadGame(env, gameId);
  if (!game) return err(404, 'not_found', 'no such game');
  const body = await readJson(req);
  const p = await parties(env, gameId, session, body);
  if (p.error) return p.error;
  const { me, them } = p;

  const war = await openWar(env, gameId, me.id, them.id);
  if (!war) return err(409, 'not_at_war', `you are not at war with ${them.name}`);
  const tick = game.current_tick ?? 0;

  // Their offer already on the table — this call is the acceptance, and
  // the war is over. Checked FIRST so a simultaneous offer from both
  // sides resolves as peace rather than as two competing proposals.
  if (war.ceasefire_by && war.ceasefire_by !== me.id) {
    await env.DB
      .prepare('UPDATE game_wars SET ended_at_tick = ?, ended_by = ? WHERE id = ?')
      .bind(tick, me.id, war.id)
      .run();
    await chronicle(env, gameId, tick, 'war_ended', me.id, them.id, {
      war_id: war.id, ticks_fought: tick - war.declared_at_tick,
      offered_by: war.ceasefire_by,
    });
    await notifyRoom(env, gameId, { type: 'wars_changed' });
    return json({
      ok: true, state: 'ended', war_id: war.id,
      ticks_fought: tick - war.declared_at_tick,
    });
  }

  if (war.ceasefire_by === me.id) {
    return err(409, 'already_offered',
      `you have already offered ${them.name} a ceasefire — they have not taken it`);
  }

  // Nothing on the table: this is the offer. The war runs on.
  await env.DB
    .prepare('UPDATE game_wars SET ceasefire_by = ?, ceasefire_at_tick = ? WHERE id = ?')
    .bind(me.id, tick, war.id)
    .run();
  await chronicle(env, gameId, tick, 'ceasefire_offered', me.id, them.id, {
    war_id: war.id, ticks_fought: tick - war.declared_at_tick,
  });
  await notifyRoom(env, gameId, { type: 'wars_changed' });
  return json({ ok: true, state: 'offered', war_id: war.id });
}

/** Take back an offer the other side has not answered. The war was never
 *  interrupted, so there is nothing to restart. */
export async function handleEndUndo(req, env, { session, params }) {
  const { gameId } = params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'bad game id');
  const game = await loadGame(env, gameId);
  if (!game) return err(404, 'not_found', 'no such game');
  const body = await readJson(req);
  const p = await parties(env, gameId, session, body);
  if (p.error) return p.error;
  const { me, them } = p;

  const war = await openWar(env, gameId, me.id, them.id);
  if (!war) return err(409, 'not_at_war', `you are not at war with ${them.name}`);
  if (war.ceasefire_by !== me.id) {
    return err(409, 'no_offer', 'you have no ceasefire on the table with them');
  }
  const tick = game.current_tick ?? 0;
  await env.DB
    .prepare('UPDATE game_wars SET ceasefire_by = NULL, ceasefire_at_tick = NULL WHERE id = ?')
    .bind(war.id)
    .run();
  await chronicle(env, gameId, tick, 'ceasefire_withdrawn', me.id, them.id, { war_id: war.id });
  await notifyRoom(env, gameId, { type: 'wars_changed' });
  return json({ ok: true, state: 'withdrawn', war_id: war.id });
}

export async function handleList(req, env, { session, params }) {
  const { gameId } = params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'bad game id');
  const me = await callerFaction(env, gameId, session.user_id);
  if (!me) return err(403, 'forbidden', 'you hold no faction in this game');
  const rows = (await env.DB
    .prepare(
      `SELECT id, faction_a, faction_b, declared_by, declared_at_tick,
              ended_at_tick, ended_by, origin, ceasefire_by, ceasefire_at_tick
         FROM game_wars WHERE game_id = ? ORDER BY declared_at_tick DESC`,
    )
    .bind(gameId)
    .all()).results ?? [];
  return json({
    wars: rows.map(r => ({
      id: r.id,
      factions: [r.faction_a, r.faction_b],
      declared_by: r.declared_by,
      declared_at_tick: r.declared_at_tick,
      ended_at_tick: r.ended_at_tick,
      ended_by: r.ended_by,
      origin: r.origin,
      open: r.ended_at_tick == null,
      mine: r.faction_a === me.id || r.faction_b === me.id,
      // Who has offered to stop, if anyone. The panel needs to tell
      // "waiting on them" from "they are waiting on you", and those are
      // opposite buttons.
      ceasefire_by: r.ceasefire_by ?? null,
      ceasefire_at_tick: r.ceasefire_at_tick ?? null,
    })),
  });
}

export const routes = [
  {
    method: 'GET',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/wars$/,
    auth: 'required',
    handle: handleList,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/wars\/declare$/,
    auth: 'required',
    handle: handleDeclare,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/wars\/end$/,
    auth: 'required',
    handle: handleEnd,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/wars\/end\/undo$/,
    auth: 'required',
    handle: handleEndUndo,
  },
];
