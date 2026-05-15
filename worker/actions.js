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
  const dvP = Number(body.dv_prograde ?? 0);
  const dvN = Number(body.dv_normal ?? 0);
  const dvR = Number(body.dv_radial ?? 0);
  const fuelCost = Math.max(0, Number(body.fuel_cost ?? 0));
  if (fuelCost > ship.fuel) return err(409, 'insufficient_fuel', 'not enough fuel for this burn');

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
         scheduled_t, dv_prograde, dv_normal, dv_radial, fuel_cost,
         status, committed_at_tick)
       VALUES (?, ?, ?, ?, 'absolute', ?, ?, ?, ?, ?, ?, 'committed',
               (SELECT current_tick FROM games WHERE id = ?))`,
    )
    .bind(nodeId, gameId, shipId, seq, targetBodyId, scheduledT, dvP, dvN, dvR, fuelCost, gameId)
    .run();

  return json({ node: { id: nodeId, ship_id: shipId, sequence: seq, status: 'committed', scheduled_t: scheduledT } }, { status: 201 });
}

// POST /api/games/:gameId/bodies/:bodyId/build
// body: { ship_class, ship_name? }
// Validates: caller owns body, body has shipyard_level >= 1, faction can pay.
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
    .prepare('SELECT id, owner_faction_id, shipyard_level FROM game_bodies WHERE id = ? AND game_id = ?')
    .bind(bodyId, gameId)
    .first();
  if (!bodyRow) return err(404, 'not_found', 'body not found');
  if (bodyRow.owner_faction_id !== me.id) return err(403, 'not_owner', 'you do not own this body');
  if ((bodyRow.shipyard_level ?? 0) < 1) {
    return err(409, 'no_shipyard', 'body has no shipyard (need shipyard_level >= 1)');
  }

  if (me.fuel < cost.fuel || me.metal < cost.metal || me.gold < cost.gold) {
    return err(409, 'insufficient_resources', `need ${cost.metal}M ${cost.fuel}F ${cost.gold}G`);
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
        `UPDATE game_factions SET fuel = fuel - ?, metal = metal - ?, gold = gold - ?
          WHERE id = ?`,
      )
      .bind(cost.fuel, cost.metal, cost.gold, me.id),
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
// Cost is fixed for v1: 30 metal, 20 fuel, 20 gold. Caller's faction must
// have a freighter in orbit OR own the body, and resources to spare.
const SETTLEMENT_COST = { fuel: 20, metal: 30, gold: 20 };

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

  if (me.fuel < SETTLEMENT_COST.fuel || me.metal < SETTLEMENT_COST.metal || me.gold < SETTLEMENT_COST.gold) {
    return err(409, 'insufficient_resources',
      `need ${SETTLEMENT_COST.metal}M ${SETTLEMENT_COST.fuel}F ${SETTLEMENT_COST.gold}G`);
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
      .prepare('UPDATE game_factions SET fuel = fuel - ?, metal = metal - ?, gold = gold - ? WHERE id = ?')
      .bind(SETTLEMENT_COST.fuel, SETTLEMENT_COST.metal, SETTLEMENT_COST.gold, me.id),
  ]);

  return json({ settlement: { id, body_id: bodyId, type, name, hp, hp_max: hp } }, { status: 201 });
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
];
