import { recomputeBodyOwnership } from './factions.js';

// Player-action endpoints: things the client wants the server to remember.
//
// The tick resolver (Room DO alarm) will eventually execute these on
// schedule. v1 of these endpoints just validates + persists the intent so
// the canvas can show committed maneuvers and queued builds after a /state
// refetch.

const GAME_ID_RE   = /^[A-Za-z0-9_-]{6,32}$/;
const SHIP_ID_RE   = /^[A-Za-z0-9_:-]{6,80}$/;
const BODY_ID_RE   = /^[A-Za-z0-9_:-]{1,80}$/;
const SHIP_CLASSES = new Set(['corvette', 'frigate', 'destroyer', 'freighter']);

// Mirrors src/game/shipClasses.ts. Server pays the resource cost in faction
// columns (metal/fuel/gold). Note ore->metal and credits->gold renames
// (server schema vs client naming).
const SHIP_BUILD_COST = {
  corvette:  { fuel: 10, metal: 15, gold: 10, build_ticks: 30 },
  frigate:   { fuel: 20, metal: 30, gold: 25, build_ticks: 60 },
  destroyer: { fuel: 40, metal: 60, gold: 50, build_ticks: 120 },
  freighter: { fuel: 15, metal: 20, gold: 15, build_ticks: 45 },
};

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

async function requireMyFaction(env, gameId, userId) {
  return env.DB
    .prepare('SELECT id, slot, metal, fuel, gold, science FROM game_factions WHERE game_id = ? AND user_id = ?')
    .bind(gameId, userId)
    .first();
}

// POST /api/games/:gameId/ships/:shipId/transfer
// body: { target_body_id, scheduled_t, dv_prograde, dv_normal?, dv_radial?, fuel_cost }
// Records a 'committed' maneuver node so the tick resolver can pick it up.
async function handleCommitTransfer(req, env, ctx) {
  const { gameId, shipId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  if (!SHIP_ID_RE.test(shipId)) return err(400, 'bad_request', 'invalid ship id');

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const ship = await env.DB
    .prepare('SELECT id, owner_faction_id, fuel FROM game_ships WHERE id = ? AND game_id = ?')
    .bind(shipId, gameId)
    .first();
  if (!ship) return err(404, 'not_found', 'ship not found');
  if (ship.owner_faction_id !== me.id) return err(403, 'not_owner', 'you do not own this ship');

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return err(400, 'bad_request', 'invalid body');
  const targetBodyId = body.target_body_id;
  if (typeof targetBodyId !== 'string' || !BODY_ID_RE.test(targetBodyId)) {
    return err(400, 'bad_request', 'invalid target_body_id');
  }
  const target = await env.DB
    .prepare('SELECT 1 AS x FROM game_bodies WHERE id = ? AND game_id = ?')
    .bind(targetBodyId, gameId)
    .first();
  if (!target) return err(404, 'not_found', 'target body not found');

  const scheduledT = Number(body.scheduled_t);
  if (!Number.isFinite(scheduledT) || scheduledT < 0) {
    return err(400, 'bad_request', 'invalid scheduled_t');
  }
  // Client now computes travel time as plain distance/SHIP_SPEED and
  // sends arrival_t in the intent. Server used to re-derive this in
  // the alarm via a Hohmann formula that gave 400+ ticks for moon
  // transfers (μ_sun applied to moon-around-planet orbit radii) —
  // see src/physics/bezierTransfer.ts for the new formula. Validate
  // it's strictly after departure; fall back to a small default if
  // the client omits it for backward compat with an older bundle.
  const arrivalT = body.arrival_t != null ? Number(body.arrival_t) : null;
  if (arrivalT != null && (!Number.isFinite(arrivalT) || arrivalT <= scheduledT)) {
    return err(400, 'bad_request', 'invalid arrival_t');
  }
  const dvP = Number(body.dv_prograde ?? 0);
  const dvN = Number(body.dv_normal ?? 0);
  const dvR = Number(body.dv_radial ?? 0);
  // Fuel was removed from the game economy. We still accept the field
  // and store it on the node so the existing schema works, but we no
  // longer reject a burn for insufficient fuel.
  const fuelCost = Math.max(0, Number(body.fuel_cost ?? 0));

  // Find next sequence for this ship.
  const last = await env.DB
    .prepare('SELECT MAX(sequence) AS m FROM game_ship_nodes WHERE ship_id = ?')
    .bind(shipId)
    .first();
  const seq = (last?.m ?? -1) + 1;

  const nodeId = `${shipId}:n${seq}`;
  await env.DB
    .prepare(
      `INSERT INTO game_ship_nodes
        (id, game_id, ship_id, sequence, anchor_kind, target_body_id,
         scheduled_t, arrival_at_tick, dv_prograde, dv_normal, dv_radial, fuel_cost,
         status, committed_at_tick)
       VALUES (?, ?, ?, ?, 'absolute', ?, ?, ?, ?, ?, ?, ?, 'committed',
               (SELECT current_tick FROM games WHERE id = ?))`,
    )
    .bind(nodeId, gameId, shipId, seq, targetBodyId, scheduledT, arrivalT, dvP, dvN, dvR, fuelCost, gameId)
    .run();

  return json({ node: { id: nodeId, ship_id: shipId, sequence: seq, status: 'committed', scheduled_t: scheduledT } }, { status: 201 });
}

// ============================================================
// Cancel endpoints
//
// Players need to be able to back out of a queued build or a
// planned/committed transfer if they made a mistake or changed plans.
// Without these, optimistic local removal was clobbered by the next
// /state poll because the server row never went away — the user
// reported "I can't cancel ship-building or transfers like 90% of
// the time."
//
// Build cancel marks cancelled_at_tick on game_body_build_queue and
// refunds the metal/gold spent at queue time. The alarm already
// skips cancelled rows in resolveTick's completion sweep.
//
// Node cancel flips status='cancelled' on game_ship_nodes. The alarm
// already skips non-committed nodes; cancelling a node that's already
// 'in_transit' is allowed but doesn't refund fuel or stop the ship
// from arriving (the burn has fired) — surfacing as a soft warning
// would be a future polish; for now it just becomes a no-op refund.
// ============================================================

// Per-class refund table. Mirrors SHIP_BUILD_COST at the top of this
// file. Kept inline so the constant doesn't drift; if the build cost
// changes, this needs to update too.
async function handleCancelBuild(req, env, ctx) {
  const { gameId, orderId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const order = await env.DB
    .prepare(
      `SELECT id, faction_id, ship_class, completes_at_tick, cancelled_at_tick
         FROM game_body_build_queue
        WHERE id = ? AND game_id = ?`,
    )
    .bind(orderId, gameId)
    .first();
  if (!order) return err(404, 'not_found', 'build order not found');
  if (order.faction_id !== me.id) return err(403, 'not_owner', 'not your build order');
  if (order.cancelled_at_tick != null) {
    return err(409, 'already_cancelled', 'this build was already cancelled');
  }

  // Refund the build cost. (fuel was removed from server-side build
  // cost gating, but we keep the column rounding-trip-safe.)
  const cost = SHIP_BUILD_COST[order.ship_class];
  const game = await env.DB
    .prepare('SELECT current_tick FROM games WHERE id = ?')
    .bind(gameId)
    .first();
  const tick = game?.current_tick ?? 0;

  await env.DB.batch([
    env.DB
      .prepare('UPDATE game_body_build_queue SET cancelled_at_tick = ? WHERE id = ?')
      .bind(tick, orderId),
    env.DB
      .prepare('UPDATE game_factions SET metal = metal + ?, gold = gold + ? WHERE id = ?')
      .bind(cost?.metal ?? 0, cost?.gold ?? 0, me.id),
  ]);

  return json({
    ok: true,
    order_id: orderId,
    refund: { metal: cost?.metal ?? 0, gold: cost?.gold ?? 0 },
  });
}

async function handleCancelNode(req, env, ctx) {
  const { gameId, nodeId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  // Ownership: a node belongs to a ship belongs to a faction.
  const row = await env.DB
    .prepare(
      `SELECT n.id, n.status, n.ship_id, s.owner_faction_id AS fid
         FROM game_ship_nodes n
         JOIN game_ships s ON s.id = n.ship_id
        WHERE n.id = ? AND n.game_id = ?`,
    )
    .bind(nodeId, gameId)
    .first();
  if (!row) return err(404, 'not_found', 'node not found');
  if (row.fid !== me.id) return err(403, 'not_owner', 'not your ship');
  if (row.status === 'executed' || row.status === 'cancelled') {
    return err(409, 'already_resolved', `node is already ${row.status}`);
  }

  await env.DB
    .prepare("UPDATE game_ship_nodes SET status = 'cancelled' WHERE id = ?")
    .bind(nodeId)
    .run();

  return json({ ok: true, node_id: nodeId, was: row.status });
}

// POST /api/games/:gameId/bodies/:bodyId/build
// body: { ship_class, ship_name? }
// Validates: caller owns body, faction can pay. (shipyard_level gate was
// dropped — the column was declared with DEFAULT 0 in 0003_game_state.sql
// and nothing ever incremented it, so every MP build 409'd.)
async function handleQueueBuild(req, env, ctx) {
  const { gameId, bodyId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  if (!BODY_ID_RE.test(bodyId)) return err(400, 'bad_request', 'invalid body id');

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return err(400, 'bad_request', 'invalid body');
  const shipClass = body.ship_class;
  if (typeof shipClass !== 'string' || !SHIP_CLASSES.has(shipClass)) {
    return err(400, 'bad_request', 'invalid ship_class');
  }
  const cost = SHIP_BUILD_COST[shipClass];

  const bodyRow = await env.DB
    .prepare('SELECT id, owner_faction_id FROM game_bodies WHERE id = ? AND game_id = ?')
    .bind(bodyId, gameId)
    .first();
  if (!bodyRow) return err(404, 'not_found', 'body not found');
  if (bodyRow.owner_faction_id !== me.id) return err(403, 'not_owner', 'you do not own this body');
  // shipyard_level gate removed: schema declared the column with
  // DEFAULT 0 (migrations/0003_game_state.sql) and nothing ever wrote
  // to it, so every MP build 409'd as no_shipyard. Body ownership
  // (recomputeBodyOwnership requires the most settlements at the body)
  // is the real gate.

  // Fuel was removed from the economy; only metal + gold are spent on builds.
  if (me.metal < cost.metal || me.gold < cost.gold) {
    return err(409, 'insufficient_resources', `need ${cost.metal}M ${cost.gold}G`);
  }

  const game = await env.DB
    .prepare('SELECT current_tick FROM games WHERE id = ?')
    .bind(gameId)
    .first();
  const startTick = game?.current_tick ?? 0;
  const completeTick = startTick + cost.build_ticks;

  const orderId = `${bodyId}:b${Date.now().toString(36)}`;

  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO game_body_build_queue
          (id, game_id, body_id, faction_id, ship_class, queued_at_tick, completes_at_tick)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(orderId, gameId, bodyId, me.id, shipClass, startTick, completeTick),
    env.DB
      .prepare(
        `UPDATE game_factions SET metal = metal - ?, gold = gold - ?
          WHERE id = ?`,
      )
      .bind(cost.metal, cost.gold, me.id),
  ]);

  return json({
    order: {
      id: orderId,
      body_id: bodyId,
      ship_class: shipClass,
      queued_at_tick: startTick,
      completes_at_tick: completeTick,
    },
  }, { status: 201 });
}

// POST /api/games/:gameId/bodies/:bodyId/settlement
// body: { type: 'city'|'station', name? }
// Cost is fixed for v1: 30 metal, 20 gold (fuel was removed from the
// economy). Caller's faction must have a ship in orbit OR own the body.
const SETTLEMENT_COST = { metal: 30, gold: 20 };

async function handleDeploySettlement(req, env, ctx) {
  const { gameId, bodyId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  if (!BODY_ID_RE.test(bodyId)) return err(400, 'bad_request', 'invalid body id');

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return err(400, 'bad_request', 'invalid body');
  const type = body.type;
  if (type !== 'city' && type !== 'station') return err(400, 'bad_request', "type must be 'city' or 'station'");

  const bodyRow = await env.DB
    .prepare('SELECT id, type, radius, owner_faction_id FROM game_bodies WHERE id = ? AND game_id = ?')
    .bind(bodyId, gameId)
    .first();
  if (!bodyRow) return err(404, 'not_found', 'body not found');

  // Surface settlements require a landable surface — no gas giants or the star.
  if (type === 'city' && (bodyRow.type === 'star' || bodyRow.type === 'gas-giant' || bodyRow.type === 'ice-giant')) {
    return err(409, 'no_surface', 'cannot found a city on this body type');
  }

  // Caller needs a ship orbiting here OR they already own the body.
  const presence = await env.DB
    .prepare(
      `SELECT 1 AS x FROM game_ships
        WHERE game_id = ? AND owner_faction_id = ? AND parent_body_id = ?
          AND status = 'active'
        LIMIT 1`,
    )
    .bind(gameId, me.id, bodyId)
    .first();
  if (!presence && bodyRow.owner_faction_id !== me.id) {
    return err(403, 'no_presence', 'need a ship at this body to deploy');
  }

  if (me.metal < SETTLEMENT_COST.metal || me.gold < SETTLEMENT_COST.gold) {
    return err(409, 'insufficient_resources',
      `need ${SETTLEMENT_COST.metal}M ${SETTLEMENT_COST.gold}G`);
  }

  const game = await env.DB.prepare('SELECT current_tick FROM games WHERE id = ?').bind(gameId).first();
  const tick = game?.current_tick ?? 0;

  const name = (typeof body.name === 'string' && body.name.trim())
    ? body.name.trim().slice(0, 40)
    : (type === 'city' ? 'New City' : 'Station');

  const id = `${bodyId}:${type[0]}${Date.now().toString(36)}`;
  const hp = type === 'city' ? 100 : 60;

  // Geometry: cities pick a random surface angle. Stations get a tight
  // circular orbit just above body.radius.
  const surfaceAngle = type === 'city' ? Math.random() * Math.PI * 2 : null;
  const rp = type === 'station' ? (bodyRow.radius || 4) + 3 : null;

  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO game_settlements
          (id, game_id, body_id, owner_faction_id, type, name,
           hp, hp_max, population,
           surface_angle, orbit_rp, orbit_ra, orbit_omega, orbit_m0, orbit_epoch,
           created_at_tick)
         VALUES (?, ?, ?, ?, ?, ?,
                 ?, ?, 1,
                 ?, ?, ?, 0, 0, ?,
                 ?)`,
      )
      .bind(id, gameId, bodyId, me.id, type, name,
            hp, hp,
            surfaceAngle, rp, rp, tick,
            tick),
    env.DB
      .prepare('UPDATE game_factions SET metal = metal - ?, gold = gold - ? WHERE id = ?')
      .bind(SETTLEMENT_COST.metal, SETTLEMENT_COST.gold, me.id),
  ]);

  // Body ownership = "faction with the most settlements here". The brand
  // new settlement may have just tipped the balance — recompute.
  await recomputeBodyOwnership(env.DB, gameId, bodyId);

  return json({ settlement: { id, body_id: bodyId, type, name, hp, hp_max: hp } }, { status: 201 });
}

// Mirror of src/game/techs.ts TECH_DEFS. Server-authoritative so a client
// can't lie about cost. costForNext(level) = ceil(baseCost * (level+1)^scaling).
const TECH_DEFS = {
  weapons:      { baseCost: 40, costScaling: 1.7 },
  armor:        { baseCost: 40, costScaling: 1.7 },
  propulsion:   { baseCost: 35, costScaling: 1.6 },
  flight:       { baseCost: 50, costScaling: 1.7 },
  construction: { baseCost: 50, costScaling: 1.8 },
  industry:     { baseCost: 45, costScaling: 1.7 },
  sensors:      { baseCost: 30, costScaling: 1.5 },
};

/** Mirror of src/game/techs.ts TECH_MAX_LEVEL. Hard cap per track —
 *  reaching this on every track is Science Victory. */
const TECH_MAX_LEVEL = 10;

function techCostForNext(level, def) {
  return Math.ceil(def.baseCost * Math.pow(level + 1, def.costScaling));
}

// POST /api/games/:gameId/research
// body: { tech_id }
// Spends science to bump faction_techs.level by 1 for the chosen tech.
// Stellaris-repeatables pattern: instant research, exponential cost.
async function handleResearch(req, env, ctx) {
  const { gameId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return err(400, 'bad_request', 'invalid body');
  const techId = body.tech_id;
  if (typeof techId !== 'string' || !TECH_DEFS[techId]) {
    return err(400, 'bad_request', 'invalid tech_id');
  }

  const cur = await env.DB
    .prepare('SELECT level FROM faction_techs WHERE game_id = ? AND faction_id = ? AND tech_id = ?')
    .bind(gameId, me.id, techId)
    .first();
  const curLevel = cur?.level ?? 0;

  // Cap at TECH_MAX_LEVEL — required for the Science Victory condition
  // to be reachable. Mirrors the client-side cap in techs.ts.
  if (curLevel >= TECH_MAX_LEVEL) {
    return err(409, 'tech_maxed', `${techId} is already at max level ${TECH_MAX_LEVEL}`);
  }

  const cost = techCostForNext(curLevel, TECH_DEFS[techId]);

  if ((me.science ?? 0) < cost) {
    return err(409, 'insufficient_resources', `need ${cost} science for ${techId} level ${curLevel + 1}`);
  }

  const game = await env.DB.prepare('SELECT current_tick FROM games WHERE id = ?').bind(gameId).first();
  const tick = game?.current_tick ?? 0;

  if (cur) {
    await env.DB.batch([
      env.DB
        .prepare(
          `UPDATE faction_techs SET level = level + 1, status = 'completed', completed_at_tick = ?
            WHERE game_id = ? AND faction_id = ? AND tech_id = ?`,
        )
        .bind(tick, gameId, me.id, techId),
      env.DB
        .prepare('UPDATE game_factions SET science = science - ? WHERE id = ?')
        .bind(cost, me.id),
    ]);
  } else {
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO faction_techs
            (game_id, faction_id, tech_id, status, level, started_at_tick, completed_at_tick)
           VALUES (?, ?, ?, 'completed', 1, ?, ?)`,
        )
        .bind(gameId, me.id, techId, tick, tick),
      env.DB
        .prepare('UPDATE game_factions SET science = science - ? WHERE id = ?')
        .bind(cost, me.id),
    ]);
  }

  return json({
    tech_id: techId,
    level: curLevel + 1,
    cost_paid: cost,
    next_cost: techCostForNext(curLevel + 1, TECH_DEFS[techId]),
  }, { status: 201 });
}

// ============================================================
// Turn-Based Mode endpoints (MP)
//
// /turn/settings  — host enables/disables TBM, sets ticks_per_turn
// /turn/commit    — caller's faction declares ready for current turn.
//                   When the last faction commits, the worker advances
//                   the sim by ticks_per_turn ticks in one batch.
// /turn/status    — read current readiness for HUD display.
//
// Implementation notes:
//  * `games.turn_based_enabled` gates the Room DO alarm (see worker/room.js
//    alarm() — short-circuits when the flag is on, so wall-clock time
//    stops driving ticks).
//  * `games.current_turn_number` increments after each successful batch,
//    invalidating any stale rows in `game_turn_commits` from prior turns.
//  * Batch advance is a tick-by-tick loop calling resolveTick(gameId, t)
//    so interval-based logic (combat cadence, settlement growth) fires at
//    the right moments. Yes, that's N round-trips per turn; acceptable
//    for a prototype with N=20 default. Future: vectorize into one pass.
// ============================================================

async function handleTurnSettings(req, env, ctx) {
  const { gameId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  // Host-only. games.id === rooms.id (handleStart writes both with the
  // same id), so a direct lookup on rooms.host_id is the canonical check.
  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');
  const room = await env.DB
    .prepare('SELECT host_id FROM rooms WHERE id = ?')
    .bind(gameId)
    .first();
  if (!room || room.host_id !== ctx.session.user_id) {
    return err(403, 'not_host', 'only the host can change turn settings');
  }

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return err(400, 'bad_request', 'invalid body');
  const enabled = body.enabled ? 1 : 0;
  const ticks = Math.max(1, Math.min(500, Math.floor(Number(body.ticks_per_turn ?? 20))));

  // Read current state so we can re-arm the alarm if TBM is being toggled
  // off. When TBM is enabled, the DO's alarm() sets storage.setAlarm to
  // 24h ahead and never updates next_tick_at, so toggling TBM back off
  // would leave the game frozen until that 24h timer pops (or the cron
  // happens to ping at the right moment). Force a fresh next_tick_at
  // here so the next cron tick or DO alarm wakes the game promptly.
  const prev = await env.DB
    .prepare('SELECT turn_based_enabled, tick_interval_ms FROM games WHERE id = ?')
    .bind(gameId)
    .first();

  await env.DB
    .prepare('UPDATE games SET turn_based_enabled = ?, ticks_per_turn = ? WHERE id = ?')
    .bind(enabled, ticks, gameId)
    .run();

  // Toggling TBM OFF: rewrite next_tick_at to "now + tick_interval_ms"
  // and ask the Room DO to re-arm its alarm to match. Idempotent for
  // the cron path; necessary for the natural DO-alarm path.
  if (prev && prev.turn_based_enabled === 1 && enabled === 0) {
    const interval = prev.tick_interval_ms ?? 60_000;
    const nextAt = Date.now() + interval;
    await env.DB
      .prepare('UPDATE games SET next_tick_at = ? WHERE id = ?')
      .bind(nextAt, gameId)
      .run();
    try {
      await env.ROOM.get(env.ROOM.idFromName(gameId)).fetch('https://room/tick-now', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: false, gameId }),
      });
    } catch {
      // Cron will pick it up within ~60s if the direct poke fails.
    }
  }

  return json({ ok: true, turn_based_enabled: enabled === 1, ticks_per_turn: ticks });
}

async function handleTurnCommit(req, env, ctx) {
  const { gameId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const game = await env.DB
    .prepare('SELECT current_tick, current_turn_number, turn_based_enabled, ticks_per_turn FROM games WHERE id = ?')
    .bind(gameId)
    .first();
  if (!game) return err(404, 'not_found', 'game not found');
  if (game.turn_based_enabled !== 1) {
    return err(409, 'tbm_disabled', 'turn-based mode is not enabled on this game');
  }

  const turnN = game.current_turn_number ?? 0;
  const now = Date.now();

  // Record commit. PK conflict = idempotent re-commit; treat as success.
  try {
    await env.DB
      .prepare(
        `INSERT INTO game_turn_commits (game_id, faction_id, turn_number, committed_at_ms)
           VALUES (?, ?, ?, ?)`,
      )
      .bind(gameId, me.id, turnN, now)
      .run();
  } catch (_e) { /* PK conflict — already committed, treat as ok */ }

  // Count human factions in this game vs how many have committed for this turn.
  // AI factions don't need to commit (they have no UI), so they're excluded
  // from the "all ready" check. Until AI players exist (slot.is_ai), every
  // faction with a non-null user_id counts as needing a commit.
  const total = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM game_factions
               WHERE game_id = ? AND user_id IS NOT NULL`)
    .bind(gameId)
    .first();
  const ready = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM game_turn_commits
               WHERE game_id = ? AND turn_number = ?`)
    .bind(gameId, turnN)
    .first();

  const needed = Number(total?.n ?? 0);
  const haveN = Number(ready?.n ?? 0);

  // Not everyone in yet — just acknowledge and let the next /state poll
  // surface the new ready count.
  if (haveN < needed) {
    return json({
      ok: true,
      ready: haveN,
      needed,
      turn_number: turnN,
      advanced: false,
    });
  }

  // All in. Run the batch: advance by ticks_per_turn ticks, calling
  // resolveTick per intermediate tick so interval-based logic fires at
  // the right moments. We grab the Room DO stub via env.ROOM and call
  // through to its resolveTick — that keeps the per-tick logic in one
  // place rather than duplicating the alarm body here.
  const ticksPerTurn = Math.max(1, Number(game.ticks_per_turn ?? 20));
  const startTick = Number(game.current_tick ?? 0);

  try {
    const stub = env.ROOM.get(env.ROOM.idFromName(gameId));
    // Cross-DO call via fetch with a synthetic URL the room knows about.
    // The room exposes /__internal/advance for this purpose (added below
    // in room.js handle() routing).
    const res = await stub.fetch(`https://room/__internal/advance?gameId=${encodeURIComponent(gameId)}&ticks=${ticksPerTurn}`, {
      method: 'POST',
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('advance call failed', res.status, text);
      return err(500, 'advance_failed', 'tick batch failed; see server logs');
    }
  } catch (e) {
    console.error('advance dispatch failed', e);
    return err(500, 'advance_failed', String(e?.message || e));
  }

  return json({
    ok: true,
    ready: haveN,
    needed,
    turn_number: turnN,
    advanced: true,
    advanced_ticks: ticksPerTurn,
    new_tick: startTick + ticksPerTurn,
    new_turn_number: turnN + 1,
  });
}

async function handleTurnStatus(req, env, ctx) {
  const { gameId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const game = await env.DB
    .prepare('SELECT current_tick, current_turn_number, turn_based_enabled, ticks_per_turn FROM games WHERE id = ?')
    .bind(gameId)
    .first();
  if (!game) return err(404, 'not_found', 'game not found');

  const turnN = game.current_turn_number ?? 0;

  const factions = await env.DB
    .prepare(`SELECT id, name FROM game_factions
               WHERE game_id = ? AND user_id IS NOT NULL`)
    .bind(gameId)
    .all();
  const commits = await env.DB
    .prepare(`SELECT faction_id, committed_at_ms FROM game_turn_commits
               WHERE game_id = ? AND turn_number = ?`)
    .bind(gameId, turnN)
    .all();

  const committedSet = new Set((commits.results ?? []).map(r => r.faction_id));
  const factionStates = (factions.results ?? []).map(f => ({
    id: f.id,
    name: f.name,
    committed: committedSet.has(f.id),
  }));

  return json({
    turn_based_enabled: game.turn_based_enabled === 1,
    ticks_per_turn: game.ticks_per_turn ?? 20,
    current_tick: game.current_tick ?? 0,
    turn_number: turnN,
    me_committed: committedSet.has(me.id),
    factions: factionStates,
    ready: factionStates.filter(f => f.committed).length,
    needed: factionStates.length,
  });
}

// ============================================================
// Admin: grant resources (host-only).
//
// POST /api/games/:gameId/admin/grant
//   body: { faction_id: string | 'all', fuel?, ore?, credits?, science? }
// Bumps the chosen faction's pool by the supplied delta. Used when the
// client AdminGrantModal repairs a busted state (e.g. the MP build-queue
// bug that ate resources without surfacing the queue) or when a host
// wants to rebalance mid-playtest. Rejects 403 if the caller isn't the
// room host. Clamps each pool floor to 0 — drains never go negative.
// ============================================================

async function handleAdminGrant(req, env, ctx) {
  const { gameId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  // Host-only. games.id === rooms.id (same string is used for both —
  // see worker/lobby.js handleStart which does INSERT INTO games(id, ...)
  // using the roomId). No room_settings join needed.
  const room = await env.DB
    .prepare('SELECT host_id FROM rooms WHERE id = ?')
    .bind(gameId)
    .first();
  if (!room || room.host_id !== ctx.session.user_id) {
    return err(403, 'not_host', 'only the host can grant resources');
  }

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return err(400, 'bad_request', 'invalid body');
  const targetRaw = String(body.faction_id ?? '');
  if (!targetRaw) return err(400, 'bad_request', 'missing faction_id');

  // Clamp deltas to a sane range so a hostile or fat-fingered request
  // can't blow up the economy. ±1,000,000 covers any legit recovery.
  const clamp = (n) => {
    const x = Number(n);
    if (!Number.isFinite(x)) return 0;
    return Math.max(-1_000_000, Math.min(1_000_000, Math.round(x)));
  };
  const dFuel = clamp(body.fuel ?? 0);
  const dOre = clamp(body.ore ?? 0);
  const dCredits = clamp(body.credits ?? 0);
  const dScience = clamp(body.science ?? 0);

  if (!dFuel && !dOre && !dCredits && !dScience) {
    return err(400, 'bad_request', 'all deltas were zero');
  }

  // Client uses ore/credits naming; server columns are metal/gold. Map here.
  // Pools floor at 0 (use MAX so subtractions can't dive negative).
  const sql = `UPDATE game_factions
                  SET fuel    = MAX(0, fuel    + ?),
                      metal   = MAX(0, metal   + ?),
                      gold    = MAX(0, gold    + ?),
                      science = MAX(0, science + ?)
                WHERE game_id = ?`;

  if (targetRaw === 'all') {
    await env.DB.prepare(sql + '').bind(dFuel, dOre, dCredits, dScience, gameId).run();
  } else {
    await env.DB
      .prepare(sql + ' AND id = ?')
      .bind(dFuel, dOre, dCredits, dScience, gameId, targetRaw)
      .run();
  }

  return json({
    ok: true,
    applied_to: targetRaw,
    delta: { fuel: dFuel, ore: dOre, credits: dCredits, science: dScience },
  });
}

// POST /api/games/:gameId/settlements/:settlementId/collector
// Upgrades an existing player-owned settlement to a logistics endpoint.
// Charges COLLECTOR_COST (150 ore, 100 credits) and flips
// has_collector = 1 atomically. Failure modes:
//   404 not_found          — settlement missing or different game
//   403 not_owner          — settlement belongs to a different faction
//   409 already_collector  — settlement already has one
//   409 insufficient_resources — pool can't cover the cost
//
// Capitals already have has_collector = 1 from seedGameWorld so the
// "already_collector" guard catches the no-op double-build attempt.
const COLLECTOR_COST = { metal: 150, gold: 100 };

// Settlement upgrade buildings — server mirror of BUILDING_DEFS in
// src/game/settlements.ts. KEEP IN SYNC. Cost compounds geometrically
// per current level; build time compounds mildly.
//
//   cost   = floor(baseCost * costScaling^currentLevel)
//   ticks  = ceil(baseBuildTicks * buildTimeScaling^currentLevel)
//
// (server columns are metal/gold; client uses ore/credits — same thing,
// different name.)
const BUILDING_DEFS = {
  forge:    { hostType: 'city',    base: { fuel: 0, metal: 0,  gold: 40 }, costScaling: 1.6, baseTicks: 20, timeScaling: 1.3 },
  mint:     { hostType: 'city',    base: { fuel: 0, metal: 40, gold: 0  }, costScaling: 1.6, baseTicks: 20, timeScaling: 1.3 },
  lab:      { hostType: 'city',    base: { fuel: 0, metal: 30, gold: 30 }, costScaling: 1.6, baseTicks: 25, timeScaling: 1.3 },
  weapons:  { hostType: 'station', base: { fuel: 0, metal: 30, gold: 20 }, costScaling: 1.6, baseTicks: 30, timeScaling: 1.3 },
  shipyard: { hostType: 'station', base: { fuel: 0, metal: 50, gold: 30 }, costScaling: 1.7, baseTicks: 40, timeScaling: 1.3 },
};

function buildingCostAt(kind, level) {
  const def = BUILDING_DEFS[kind];
  if (!def) return null;
  const k = Math.pow(def.costScaling, level);
  return {
    metal: Math.ceil(def.base.metal * k),
    gold:  Math.ceil(def.base.gold  * k),
  };
}
function buildingTicksAt(kind, level) {
  const def = BUILDING_DEFS[kind];
  if (!def) return 0;
  return Math.ceil(def.baseTicks * Math.pow(def.timeScaling, level));
}

async function handleQueueBuilding(req, env, ctx) {
  const { gameId, settlementId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return err(400, 'bad_request', 'invalid body');
  const kind = body.kind;
  if (!BUILDING_DEFS[kind]) return err(400, 'bad_request', `invalid kind: ${kind}`);

  const settlement = await env.DB
    .prepare(
      `SELECT id, owner_faction_id, type, buildings_json, building_order_json
         FROM game_settlements
        WHERE id = ? AND game_id = ? AND destroyed_at_tick IS NULL`,
    )
    .bind(settlementId, gameId)
    .first();
  if (!settlement) return err(404, 'not_found', 'settlement not found');
  if (settlement.owner_faction_id !== me.id) {
    return err(403, 'not_owner', 'you do not own this settlement');
  }
  if (settlement.type !== BUILDING_DEFS[kind].hostType) {
    return err(409, 'wrong_host', `${kind} requires a ${BUILDING_DEFS[kind].hostType}`);
  }
  if (settlement.building_order_json) {
    return err(409, 'busy', 'this settlement already has an upgrade in progress');
  }

  // Current level for this kind (default 0)
  let buildings = {};
  if (settlement.buildings_json) {
    try { buildings = JSON.parse(settlement.buildings_json) ?? {}; } catch { buildings = {}; }
  }
  const currentLevel = Number(buildings[kind] ?? 0);
  const cost = buildingCostAt(kind, currentLevel);
  const ticks = buildingTicksAt(kind, currentLevel);

  if (me.metal < cost.metal || me.gold < cost.gold) {
    return err(409, 'insufficient_resources',
      `need ${cost.metal} ore + ${cost.gold} credits for ${kind} L${currentLevel + 1}`);
  }

  const game = await env.DB.prepare('SELECT current_tick FROM games WHERE id = ?').bind(gameId).first();
  const startTick = game?.current_tick ?? 0;
  const completeTick = startTick + ticks;

  const order = {
    id: `${settlementId}:b${Date.now().toString(36)}`,
    settlement_id: settlementId,
    kind,
    target_level: currentLevel + 1,
    start_tick: startTick,
    complete_tick: completeTick,
  };

  await env.DB.batch([
    env.DB
      .prepare('UPDATE game_settlements SET building_order_json = ? WHERE id = ?')
      .bind(JSON.stringify(order), settlementId),
    env.DB
      .prepare('UPDATE game_factions SET metal = metal - ?, gold = gold - ? WHERE id = ?')
      .bind(cost.metal, cost.gold, me.id),
  ]);

  return json({ ok: true, order, cost });
}

async function handleCancelBuilding(req, env, ctx) {
  const { gameId, settlementId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const settlement = await env.DB
    .prepare(
      `SELECT id, owner_faction_id, building_order_json, buildings_json
         FROM game_settlements
        WHERE id = ? AND game_id = ? AND destroyed_at_tick IS NULL`,
    )
    .bind(settlementId, gameId)
    .first();
  if (!settlement) return err(404, 'not_found', 'settlement not found');
  if (settlement.owner_faction_id !== me.id) return err(403, 'not_owner', 'not your settlement');
  if (!settlement.building_order_json) {
    return err(409, 'no_order', 'nothing to cancel');
  }

  let order;
  try { order = JSON.parse(settlement.building_order_json); } catch { order = null; }
  if (!order) {
    // Corrupt blob — just clear it without refunding.
    await env.DB.prepare('UPDATE game_settlements SET building_order_json = NULL WHERE id = ?')
      .bind(settlementId).run();
    return json({ ok: true, refund: null });
  }

  // Refund cost-at-queue-time.
  const refund = buildingCostAt(order.kind, Math.max(0, (order.target_level ?? 1) - 1));
  await env.DB.batch([
    env.DB
      .prepare('UPDATE game_settlements SET building_order_json = NULL WHERE id = ?')
      .bind(settlementId),
    env.DB
      .prepare('UPDATE game_factions SET metal = metal + ?, gold = gold + ? WHERE id = ?')
      .bind(refund?.metal ?? 0, refund?.gold ?? 0, me.id),
  ]);
  return json({ ok: true, refund });
}
async function handleBuildCollector(req, env, ctx) {
  const { gameId, settlementId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const settlement = await env.DB
    .prepare('SELECT id, owner_faction_id, has_collector FROM game_settlements WHERE id = ? AND game_id = ? AND destroyed_at_tick IS NULL')
    .bind(settlementId, gameId)
    .first();
  if (!settlement) return err(404, 'not_found', 'settlement not found');
  if (settlement.owner_faction_id !== me.id) {
    return err(403, 'not_owner', 'you do not own this settlement');
  }
  if (settlement.has_collector === 1) {
    return err(409, 'already_collector', 'this settlement already has a collector');
  }
  if (me.metal < COLLECTOR_COST.metal || me.gold < COLLECTOR_COST.gold) {
    return err(409, 'insufficient_resources',
      `need ${COLLECTOR_COST.metal} ore + ${COLLECTOR_COST.gold} credits`);
  }

  const game = await env.DB.prepare('SELECT current_tick FROM games WHERE id = ?').bind(gameId).first();
  const tick = game?.current_tick ?? 0;

  await env.DB.batch([
    env.DB
      .prepare('UPDATE game_settlements SET has_collector = 1, collector_built_tick = ? WHERE id = ?')
      .bind(tick, settlementId),
    env.DB
      .prepare('UPDATE game_factions SET metal = metal - ?, gold = gold - ? WHERE id = ?')
      .bind(COLLECTOR_COST.metal, COLLECTOR_COST.gold, me.id),
  ]);

  return json({
    ok: true,
    settlement_id: settlementId,
    built_at_tick: tick,
    cost: { metal: COLLECTOR_COST.metal, gold: COLLECTOR_COST.gold },
  });
}

// ============================================================
// Trade routes (MP)
//
// POST   /api/games/:gameId/trade-routes              create
// DELETE /api/games/:gameId/trade-routes/:routeId     cancel + refund
//
// The actual freighter auto-pilot lives in worker/room.js resolveTick;
// these endpoints just record/erase intent. Validation:
//   - caller owns the ship
//   - ship is a freighter
//   - origin body has a player-owned settlement (something to pick up)
//   - dest body has a player-owned settlement WITH has_collector = 1
//   - no other active route for this ship (UNIQUE INDEX guards too)
// ============================================================
async function handleCreateTradeRoute(req, env, ctx) {
  const { gameId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return err(400, 'bad_request', 'invalid body');
  const shipId       = String(body.ship_id ?? '');
  const originBodyId = String(body.origin_body_id ?? '');
  const destBodyId   = String(body.dest_body_id ?? '');
  if (!SHIP_ID_RE.test(shipId))       return err(400, 'bad_request', 'invalid ship_id');
  if (!BODY_ID_RE.test(originBodyId)) return err(400, 'bad_request', 'invalid origin_body_id');
  if (!BODY_ID_RE.test(destBodyId))   return err(400, 'bad_request', 'invalid dest_body_id');
  if (originBodyId === destBodyId)    return err(400, 'bad_request', 'origin and dest must differ');

  const ship = await env.DB
    .prepare('SELECT id, owner_faction_id, ship_class FROM game_ships WHERE id = ? AND game_id = ? AND status = ?')
    .bind(shipId, gameId, 'active')
    .first();
  if (!ship) return err(404, 'not_found', 'ship not found');
  if (ship.owner_faction_id !== me.id) return err(403, 'not_owner', 'not your ship');
  if (ship.ship_class !== 'freighter') {
    return err(409, 'wrong_class', 'only freighters can run trade routes');
  }

  // Origin must have a player-owned settlement.
  const origin = await env.DB
    .prepare('SELECT 1 AS x FROM game_settlements WHERE game_id = ? AND body_id = ? AND owner_faction_id = ? AND destroyed_at_tick IS NULL')
    .bind(gameId, originBodyId, me.id)
    .first();
  if (!origin) return err(409, 'no_origin_settlement', 'origin body has no player settlement to pick up from');

  // Dest must have a player-owned settlement with has_collector = 1.
  const destC = await env.DB
    .prepare('SELECT 1 AS x FROM game_settlements WHERE game_id = ? AND body_id = ? AND owner_faction_id = ? AND has_collector = 1 AND destroyed_at_tick IS NULL')
    .bind(gameId, destBodyId, me.id)
    .first();
  if (!destC) return err(409, 'no_dest_collector', 'destination body has no player collector to deliver to');

  // Drop any prior active route for this ship (UI lets the player
  // replace; the UNIQUE INDEX would 409 otherwise).
  const game = await env.DB.prepare('SELECT current_tick FROM games WHERE id = ?').bind(gameId).first();
  const tick = game?.current_tick ?? 0;
  await env.DB
    .prepare('UPDATE game_trade_routes SET cancelled_at_tick = ? WHERE ship_id = ? AND cancelled_at_tick IS NULL')
    .bind(tick, shipId)
    .run();

  const routeId = `tr:${shipId}:${tick}:${Math.random().toString(36).slice(2, 6)}`;
  await env.DB
    .prepare(
      `INSERT INTO game_trade_routes
         (id, game_id, owner_faction_id, ship_id,
          origin_body_id, dest_body_id, status,
          cargo_fuel, cargo_metal, cargo_gold, cargo_science,
          created_at_tick)
       VALUES (?, ?, ?, ?, ?, ?, 'returning', 0, 0, 0, 0, ?)`,
    )
    .bind(routeId, gameId, me.id, shipId, originBodyId, destBodyId, tick)
    .run();

  return json({ ok: true, route: { id: routeId, ship_id: shipId, origin_body_id: originBodyId, dest_body_id: destBodyId } });
}

async function handleCancelTradeRoute(req, env, ctx) {
  const { gameId, routeId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const route = await env.DB
    .prepare(
      `SELECT id, owner_faction_id, cancelled_at_tick,
              cargo_fuel, cargo_metal, cargo_gold, cargo_science
         FROM game_trade_routes WHERE id = ? AND game_id = ?`,
    )
    .bind(routeId, gameId)
    .first();
  if (!route) return err(404, 'not_found', 'route not found');
  if (route.owner_faction_id !== me.id) return err(403, 'not_owner', 'not your route');
  if (route.cancelled_at_tick != null) return err(409, 'already_cancelled', 'already cancelled');

  // Refund any cargo currently in the freighter's hold. Without this
  // the resources just vanish on cancel, which would punish players
  // for redirecting a freighter mid-haul.
  const game = await env.DB.prepare('SELECT current_tick FROM games WHERE id = ?').bind(gameId).first();
  const tick = game?.current_tick ?? 0;
  const fuel    = Number(route.cargo_fuel    ?? 0);
  const metal   = Number(route.cargo_metal   ?? 0);
  const gold    = Number(route.cargo_gold    ?? 0);
  const science = Number(route.cargo_science ?? 0);
  await env.DB.batch([
    env.DB
      .prepare('UPDATE game_trade_routes SET cancelled_at_tick = ?, cargo_fuel = 0, cargo_metal = 0, cargo_gold = 0, cargo_science = 0 WHERE id = ?')
      .bind(tick, routeId),
    env.DB
      .prepare('UPDATE game_factions SET fuel = fuel + ?, metal = metal + ?, gold = gold + ?, science = science + ? WHERE id = ?')
      .bind(fuel, metal, gold, science, me.id),
  ]);

  return json({ ok: true, refund: { fuel, metal, gold, science } });
}

export const routes = [
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/ships\/(?<shipId>[^/]+)\/transfer$/,
    auth: 'required',
    handle: handleCommitTransfer,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/bodies\/(?<bodyId>[^/]+)\/build$/,
    auth: 'required',
    handle: handleQueueBuild,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/bodies\/(?<bodyId>[^/]+)\/settlement$/,
    auth: 'required',
    handle: handleDeploySettlement,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/research$/,
    auth: 'required',
    handle: handleResearch,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/turn\/settings$/,
    auth: 'required',
    handle: handleTurnSettings,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/turn\/commit$/,
    auth: 'required',
    handle: handleTurnCommit,
  },
  {
    method: 'GET',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/turn\/status$/,
    auth: 'required',
    handle: handleTurnStatus,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/admin\/grant$/,
    auth: 'required',
    handle: handleAdminGrant,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/settlements\/(?<settlementId>[^/]+)\/collector$/,
    auth: 'required',
    handle: handleBuildCollector,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/settlements\/(?<settlementId>[^/]+)\/buildings$/,
    auth: 'required',
    handle: handleQueueBuilding,
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/settlements\/(?<settlementId>[^/]+)\/buildings$/,
    auth: 'required',
    handle: handleCancelBuilding,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/trade-routes$/,
    auth: 'required',
    handle: handleCreateTradeRoute,
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/trade-routes\/(?<routeId>[^/]+)$/,
    auth: 'required',
    handle: handleCancelTradeRoute,
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/builds\/(?<orderId>[^/]+)$/,
    auth: 'required',
    handle: handleCancelBuild,
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/nodes\/(?<nodeId>[^/]+)$/,
    auth: 'required',
    handle: handleCancelNode,
  },
];
