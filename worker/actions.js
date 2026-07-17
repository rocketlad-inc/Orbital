import { getActiveSliders } from './senate.js';
import { recomputeBodyOwnership } from './factions.js';
import {
  validateParts, partsCost, parsePartsJson,
  countPart, detonatorDamage,
} from './shipDesigns.js';
import { runDigestForGame } from './digest.js';

// Player-action endpoints: things the client wants the server to remember.
//
// The tick resolver (Room DO alarm) will eventually execute these on
// schedule. v1 of these endpoints just validates + persists the intent so
// the canvas can show committed maneuvers and queued builds after a /state
// refetch.

const GAME_ID_RE   = /^[A-Za-z0-9_-]{6,32}$/;
const SHIP_ID_RE   = /^[A-Za-z0-9_:-]{6,80}$/;
const BODY_ID_RE   = /^[A-Za-z0-9_:-]{1,80}$/;
const SHIP_CLASSES = new Set(['corvette', 'frigate', 'destroyer', 'freighter', 'colony']);

// Mirrors src/game/shipClasses.ts. Server pays the resource cost in faction
// columns (metal/fuel/gold). Note ore->metal and credits->gold renames
// (server schema vs client naming).
const SHIP_BUILD_COST = {
  corvette:  { fuel: 0,  metal: 5,  gold: 4,  build_ticks: 10 },
  frigate:   { fuel: 0,  metal: 10, gold: 8,  build_ticks: 20 },
  destroyer: { fuel: 0,  metal: 20, gold: 17, build_ticks: 40 },
  freighter: { fuel: 0,  metal: 7,  gold: 5,  build_ticks: 15 },
  // Colony ship — consumable expansion hull (DESIGN-identity-economy §4).
  // ~3x freighter cost: it IS the price of founding a city (deploy
  // consumes the ship instead of charging SETTLEMENT_COST).
  colony:    { fuel: 0,  metal: 20, gold: 15, build_ticks: 30 },
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
    .prepare('SELECT 1 AS x FROM game_bodies WHERE id = ? AND game_id = ? AND destroyed_at_tick IS NULL')
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

  // Assign the sequence ATOMICALLY inside the INSERT. The old code read
  // MAX(sequence) then inserted MAX+1 in two steps — two commits for the
  // same ship racing (double-click, client retry, or a burst of chained
  // legs) both read the same MAX and both tried to insert the same
  // sequence, blowing up on UNIQUE(ship_id, sequence). Computing the
  // next sequence in a subquery makes the read+write one statement;
  // SQLite/D1 serialize writers, so the second insert sees the first's
  // committed row and gets a distinct sequence. The node id no longer
  // embeds the sequence (it's opaque to the client — only round-tripped
  // for cancel), so a timestamp+random id keeps the PRIMARY KEY unique
  // without needing to know the sequence up front.
  const nodeId = `${shipId}:n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await env.DB
    .prepare(
      `INSERT INTO game_ship_nodes
        (id, game_id, ship_id, sequence, anchor_kind, target_body_id,
         scheduled_t, arrival_at_tick, dv_prograde, dv_normal, dv_radial, fuel_cost,
         status, committed_at_tick)
       SELECT ?, ?, ?,
              COALESCE((SELECT MAX(sequence) FROM game_ship_nodes WHERE ship_id = ?), -1) + 1,
              'absolute', ?, ?, ?, ?, ?, ?, ?, 'committed',
              (SELECT current_tick FROM games WHERE id = ?)`,
    )
    .bind(nodeId, gameId, shipId, shipId, targetBodyId, scheduledT, arrivalT, dvP, dvN, dvR, fuelCost, gameId)
    .run();

  // Read back the sequence the subquery assigned, for the response.
  const inserted = await env.DB
    .prepare('SELECT sequence FROM game_ship_nodes WHERE id = ?')
    .bind(nodeId)
    .first();
  const seq = inserted?.sequence ?? null;

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
      `SELECT id, faction_id, ship_class, completes_at_tick, cancelled_at_tick, parts_json
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
  // Parts were charged at queue time (snapshot of the active design) —
  // refund them too, or a cancelled fully-loaded destroyer would eat
  // the loadout price.
  const orderParts = parsePartsJson(order.ship_class, order.parts_json);
  const orderPartsCost = partsCost(orderParts);
  const refundMetal = (cost?.metal ?? 0) + orderPartsCost.metal;
  const refundGold = (cost?.gold ?? 0) + orderPartsCost.gold;
  const game = await env.DB
    .prepare('SELECT current_tick FROM games WHERE id = ?')
    .bind(gameId)
    .first();
  const tick = game?.current_tick ?? 0;

  // Flip the cancel flag FIRST, guarded on it still being NULL, and only
  // refund if this statement actually changed a row. Two concurrent
  // cancels would both pass the read-check above; SQLite serializes the
  // guarded UPDATE, so exactly one flips NULL->tick (changes=1, refunds)
  // and the rest see changes=0 (no double refund). Was: an unguarded
  // batch where every racing request refunded.
  const flip = await env.DB
    .prepare('UPDATE game_body_build_queue SET cancelled_at_tick = ? WHERE id = ? AND cancelled_at_tick IS NULL')
    .bind(tick, orderId)
    .run();
  if (!flip.meta?.changes) {
    return err(409, 'already_cancelled', 'this build was already cancelled');
  }
  // Refund covers hull + the design's parts snapshot (both were charged
  // at queue time).
  await env.DB
    .prepare('UPDATE game_factions SET metal = metal + ?, gold = gold + ? WHERE id = ?')
    .bind(refundMetal, refundGold, me.id)
    .run();

  return json({
    ok: true,
    order_id: orderId,
    refund: { metal: refundMetal, gold: refundGold },
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
  // Player-picked icon variant from the BuildPanel dropdown. Validated
  // here so a malicious / outdated client can't write garbage to the
  // column. NULL is allowed and means "use the class default" — older
  // clients that don't post the field still work.
  let iconVariant = null;
  if (body.icon_variant !== undefined && body.icon_variant !== null) {
    if (typeof body.icon_variant !== 'string' || !/^[A-F]$/.test(body.icon_variant)) {
      return err(400, 'bad_request', 'invalid icon_variant');
    }
    iconVariant = body.icon_variant;
  }
  // Optional player-typed custom name. The docstring above promised
  // ship_name was honored; the original implementation never read
  // it and the completion handler hard-coded `Corvette T142` style
  // names, so every custom name was silently dropped. NULL falls
  // through to that legacy generated name at completion time.
  let shipName = null;
  if (typeof body.ship_name === 'string') {
    const trimmed = body.ship_name.trim();
    if (trimmed.length > 0) {
      if (trimmed.length > 32) {
        return err(400, 'bad_request', 'ship_name too long (max 32 chars)');
      }
      shipName = trimmed;
    }
  }
  const cost = SHIP_BUILD_COST[shipClass];

  // Ship designer (§2): BUILD uses the caller's ACTIVE design for this
  // class. The design's parts are SNAPSHOT onto the build order here so
  // later edits to the design never mutate queued ships. No active
  // design (or a bare-hull design) = today's ship exactly.
  const activeDesign = await env.DB
    .prepare(
      `SELECT id, parts_json, icon_variant FROM game_ship_designs
        WHERE game_id = ? AND faction_id = ? AND ship_class = ? AND is_active = 1
        LIMIT 1`,
    )
    .bind(gameId, me.id, shipClass)
    .first();
  const designParts = activeDesign ? parsePartsJson(shipClass, activeDesign.parts_json) : [];
  const designPartsJson = designParts.length > 0 ? JSON.stringify(designParts) : null;
  const designPartsCost = partsCost(designParts);
  // Icon fallback chain: explicit BuildPanel pick > design's variant >
  // class default (NULL). The design variant went through the same
  // 'A'..'F' validation at design-save time.
  if (iconVariant == null && activeDesign?.icon_variant && /^[A-F]$/.test(activeDesign.icon_variant)) {
    iconVariant = activeDesign.icon_variant;
  }

  const bodyRow = await env.DB
    .prepare('SELECT id, owner_faction_id FROM game_bodies WHERE id = ? AND game_id = ? AND destroyed_at_tick IS NULL')
    .bind(bodyId, gameId)
    .first();
  if (!bodyRow) return err(404, 'not_found', 'body not found');
  // Build is allowed at any body where the player owns an active
  // settlement — surface city OR orbital station. Body ownership
  // (game_bodies.owner_faction_id) is derived from settlement counts in
  // recomputeBodyOwnership, so on a contested gas giant where another
  // faction has more settlements, body owner won't be us even though we
  // legitimately have a station here with shipyard slots. The
  // settlement-presence check is the right gate — body ownership stays
  // as a fast-path skip when it's clearly ours.
  if (bodyRow.owner_faction_id !== me.id) {
    const mineHere = await env.DB
      .prepare(
        `SELECT 1 AS x FROM game_settlements
          WHERE game_id = ? AND body_id = ? AND owner_faction_id = ?
            AND destroyed_at_tick IS NULL
          LIMIT 1`,
      )
      .bind(gameId, bodyId, me.id)
      .first();
    if (!mineHere) return err(403, 'not_owner', 'no settlement of yours at this body');
  }

  // Build concurrency. Every owned body has 1 base slot; each level of
  // a Shipyard (a station building) adds one more concurrent slot. This
  // mirrors src/game/settlements.ts shipyardSlotsAtBody. Since 0037 the
  // queue is UNLIMITED depth — orders beyond capacity are accepted with
  // status='waiting' (still charged up front) and promoted FIFO by the
  // room.js tick pass as active builds complete. Only status='building'
  // rows count against the slots.
  const yardRows = (await env.DB
    .prepare(
      `SELECT buildings_json FROM game_settlements
        WHERE game_id = ? AND body_id = ? AND owner_faction_id = ?
          AND type = 'station' AND destroyed_at_tick IS NULL`,
    )
    .bind(gameId, bodyId, me.id)
    .all()).results ?? [];
  let shipyardLevels = 0;
  for (const row of yardRows) {
    if (!row.buildings_json) continue;
    try {
      const b = JSON.parse(row.buildings_json) || {};
      shipyardLevels += Number(b.shipyard ?? 0) || 0;
    } catch { /* ignore malformed */ }
  }
  const slots = 1 + shipyardLevels;
  // Completed builds are DELETED from this table (room.js), so any
  // non-cancelled status='building' row is occupying a slot right now.
  // (Rows predating migration 0037 read status='building' via the
  // column DEFAULT, which is correct — they were all active.)
  const inFlight = await env.DB
    .prepare(
      `SELECT COUNT(*) AS c FROM game_body_build_queue
        WHERE game_id = ? AND body_id = ? AND faction_id = ?
          AND cancelled_at_tick IS NULL AND status = 'building'`,
    )
    .bind(gameId, bodyId, me.id)
    .first();
  // No rejection when slots are full — the order is accepted as
  // status='waiting' and promoted FIFO when a slot frees up. The old
  // 'no_slots' 409 is gone from the normal flow.
  const startsNow = (inFlight?.c ?? 0) < slots;

  // Senate effect: ship_build_cost_multiplier scales metal + gold at
  // queue time. Default 1.0 (no effect) when no proposal is active.
  // build_ticks is left alone -- balance lever, not the same dial.
  let buildCostMult = 1;
  try {
    const tickRow = await env.DB
      .prepare('SELECT current_tick FROM games WHERE id = ?')
      .bind(gameId).first();
    const sliders = await getActiveSliders(env, gameId, tickRow?.current_tick ?? 0);
    const v = Number(sliders.ship_build_cost_multiplier);
    if (Number.isFinite(v) && v > 0) buildCostMult = v;
  } catch { /* default */ }
  // Construction tech: −5%/level to build cost, floored at 0.25× (mirrors
  // src/game/techs.ts buildCostModifier, which SP applies in buildShip).
  // Was ignored server-side, so a construction-teched player paid full
  // price in MP while SP charged the discount. Stacks with the senate
  // multiplier.
  try {
    const ct = await env.DB
      .prepare("SELECT level FROM faction_techs WHERE game_id = ? AND faction_id = ? AND tech_id = 'construction'")
      .bind(gameId, me.id)
      .first();
    const lvl = ct?.level ?? 0;
    buildCostMult *= Math.max(0.25, 1 - 0.05 * lvl);
  } catch { /* default — no discount */ }

  // Parts are added to the hull cost at queue time (empty slots are
  // free — the bare hull is the budget option). Both multipliers above
  // scale the whole ship, parts included.
  const scaledCost = {
    metal: Math.ceil((cost.metal + designPartsCost.metal) * buildCostMult),
    fuel:  Math.ceil(cost.fuel  * buildCostMult),
    gold:  Math.ceil((cost.gold + designPartsCost.gold) * buildCostMult),
    build_ticks: cost.build_ticks,
  };

  // Local-first spend: drain settlement stockpiles at this body before
  // touching the faction pool. Lets a remote uncollectered settlement
  // self-fund ship builds from its banked LOCAL bucket.
  const localStocks = (await env.DB
    .prepare(
      `SELECT id, stockpile_metal, stockpile_gold
         FROM game_settlements
        WHERE game_id = ? AND body_id = ? AND owner_faction_id = ?
          AND destroyed_at_tick IS NULL`,
    )
    .bind(gameId, bodyId, me.id)
    .all()).results ?? [];
  let localMetal = 0, localGold = 0;
  for (const s of localStocks) {
    localMetal += Number(s.stockpile_metal ?? 0);
    localGold  += Number(s.stockpile_gold  ?? 0);
  }
  if (localMetal + me.metal < scaledCost.metal || localGold + me.gold < scaledCost.gold) {
    return err(409, 'insufficient_resources', `need ${scaledCost.metal}M ${scaledCost.gold}G (LOCAL+pool)`);
  }

  // Plan the per-settlement draws (FIFO across settlements; small
  // amounts of remainder fall to the pool). One UPDATE per settlement
  // that contributes, plus one for the pool if it covers any shortfall.
  let needMetal = scaledCost.metal;
  let needGold  = scaledCost.gold;
  const settlementDrains = [];
  for (const s of localStocks) {
    if (needMetal <= 0 && needGold <= 0) break;
    const takeM = Math.min(needMetal, Number(s.stockpile_metal ?? 0));
    const takeG = Math.min(needGold,  Number(s.stockpile_gold  ?? 0));
    if (takeM + takeG <= 0) continue;
    settlementDrains.push({ id: s.id, metal: takeM, gold: takeG });
    needMetal -= takeM;
    needGold  -= takeG;
  }
  const poolDrawMetal = needMetal;  // remainder
  const poolDrawGold  = needGold;

  const game = await env.DB
    .prepare('SELECT current_tick FROM games WHERE id = ?')
    .bind(gameId)
    .first();
  const startTick = game?.current_tick ?? 0;
  // For a waiting order completes_at_tick is a placeholder (NOT NULL
  // column) — the completion sweep filters on status='building', and
  // promotion in room.js rewrites it to promotion_tick + build_ticks.
  const completeTick = startTick + cost.build_ticks;

  const orderId = `${bodyId}:b${Date.now().toString(36)}`;

  const batchStmts = [
    env.DB
      .prepare(
        `INSERT INTO game_body_build_queue
          (id, game_id, body_id, faction_id, ship_class, queued_at_tick, completes_at_tick, icon_variant, ship_name,
           parts_json, status, build_ticks, started_at_tick)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(orderId, gameId, bodyId, me.id, shipClass, startTick, completeTick, iconVariant, shipName,
            designPartsJson, startsNow ? 'building' : 'waiting', cost.build_ticks, startsNow ? startTick : null),
  ];
  for (const d of settlementDrains) {
    batchStmts.push(
      env.DB
        .prepare(
          `UPDATE game_settlements
              SET stockpile_metal = stockpile_metal - ?,
                  stockpile_gold  = stockpile_gold  - ?
            WHERE id = ?`,
        )
        .bind(d.metal, d.gold, d.id),
    );
  }
  if (poolDrawMetal > 0 || poolDrawGold > 0) {
    batchStmts.push(
      env.DB
        .prepare('UPDATE game_factions SET metal = metal - ?, gold = gold - ? WHERE id = ?')
        .bind(poolDrawMetal, poolDrawGold, me.id),
    );
  }
  await env.DB.batch(batchStmts);

  return json({
    order: {
      id: orderId,
      body_id: bodyId,
      ship_class: shipClass,
      queued_at_tick: startTick,
      completes_at_tick: completeTick,
      parts: designParts,
      status: startsNow ? 'building' : 'waiting',
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
    .prepare('SELECT id, name, type, radius, owner_faction_id FROM game_bodies WHERE id = ? AND game_id = ? AND destroyed_at_tick IS NULL')
    .bind(bodyId, gameId)
    .first();
  if (!bodyRow) return err(404, 'not_found', 'body not found');

  // Surface settlements require a landable surface — no gas giants or the star.
  if (type === 'city' && (bodyRow.type === 'star' || bodyRow.type === 'gas-giant' || bodyRow.type === 'ice-giant')) {
    return err(409, 'no_surface', 'cannot found a city on this body type');
  }

  // One city + one station per body — enforce server-side (the client
  // already hides the deploy button, but the server is the source of
  // truth; without this a stale/forged client could stack settlements).
  // Counts any LIVING settlement of this type at the body regardless of
  // owner: a body can't host two cities even for different factions
  // under the one-settlement-per-body rule.
  const existing = await env.DB
    .prepare(
      `SELECT 1 AS x FROM game_settlements
        WHERE game_id = ? AND body_id = ? AND type = ?
          AND destroyed_at_tick IS NULL
        LIMIT 1`,
    )
    .bind(gameId, bodyId, type)
    .first();
  if (existing) {
    return err(409, 'occupied',
      `this body already has a ${type} — only one ${type} per body`);
  }

  // Expansion rules (DESIGN-identity-economy §4). Freighters lost the
  // settle verb — they haul and trade only. Instead:
  //   city:    REQUIRES a colony ship of yours orbiting this body.
  //            The ship IS the cost — it is consumed; no SETTLEMENT_COST.
  //   station: EITHER (a) you already own a settlement at this body →
  //            build from orbit for SETTLEMENT_COST (no ship needed),
  //            OR (b) consume a colony ship orbiting here (no resource
  //            cost). Path (b) is how gas giants + Sol get settled.
  const colonyShip = await env.DB
    .prepare(
      `SELECT id, name FROM game_ships
        WHERE game_id = ? AND owner_faction_id = ? AND parent_body_id = ?
          AND ship_class = 'colony'
          AND status = 'active'
        LIMIT 1`,
    )
    .bind(gameId, me.id, bodyId)
    .first();

  let consumedShip = null; // { id, name } when a colony ship pays the bill
  let payResourceCost = false;
  if (type === 'city') {
    if (!colonyShip) {
      return err(409, 'need_colony_ship',
        'founding a city requires a Colony Ship of yours in orbit here (it is consumed)');
    }
    consumedShip = colonyShip;
  } else {
    // station
    const mySettlementHere = await env.DB
      .prepare(
        `SELECT 1 AS x FROM game_settlements
          WHERE game_id = ? AND body_id = ? AND owner_faction_id = ?
            AND destroyed_at_tick IS NULL
          LIMIT 1`,
      )
      .bind(gameId, bodyId, me.id)
      .first();
    if (mySettlementHere) {
      payResourceCost = true;
      if (me.metal < SETTLEMENT_COST.metal || me.gold < SETTLEMENT_COST.gold) {
        return err(409, 'insufficient_resources',
          `need ${SETTLEMENT_COST.metal}M ${SETTLEMENT_COST.gold}G`);
      }
    } else if (colonyShip) {
      consumedShip = colonyShip;
    } else {
      return err(409, 'need_colony_ship',
        'need a settlement of yours at this body (pay metal/gold) or a Colony Ship in orbit (consumed)');
    }
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

  const deployStmts = [
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
  ];
  if (payResourceCost) {
    deployStmts.push(
      env.DB
        .prepare('UPDATE game_factions SET metal = metal - ?, gold = gold - ? WHERE id = ?')
        .bind(SETTLEMENT_COST.metal, SETTLEMENT_COST.gold, me.id),
    );
  }
  if (consumedShip) {
    // The colony ship is spent founding the settlement. Same terminal
    // shape as combat kills (room.js) so every downstream filter on
    // status='active' / destroyed_at_tick treats it as gone. Guard on
    // status='active' so a racing double-deploy can't spend one ship
    // twice (the second batch's UPDATE hits zero rows — settlement
    // still inserts, but the one-per-body 'occupied' gate above plus
    // D1 write serialization make that window effectively closed).
    deployStmts.push(
      env.DB
        .prepare(
          `UPDATE game_ships
              SET hp = 0, status = 'destroyed', destroyed_at_tick = ?
            WHERE id = ? AND status = 'active'`,
        )
        .bind(tick, consumedShip.id),
    );
  }
  await env.DB.batch(deployStmts);

  // Body ownership = "faction with the most settlements here". The brand
  // new settlement may have just tipped the balance — recompute.
  await recomputeBodyOwnership(env.DB, gameId, bodyId);

  // Chronicle the founding so the log isn't dominated by destruction
  // events. Playtester reported: "Log doesn't include any in-game logs
  // such as settlements made."
  try {
    const bodyName = bodyRow?.name ?? 'unknown body';
    const factionName = (await env.DB
      .prepare('SELECT name FROM game_factions WHERE id = ?')
      .bind(me.id).first())?.name ?? null;
    const payload = JSON.stringify({
      settlement_id: id,
      settlement_type: type,
      settlement_name: name,
      body_name: bodyName,
      owner_faction_name: factionName,
      // Set when a colony ship was spent to found this settlement —
      // lets the chronicle render "founded by CSS Mayflower".
      consumed_ship_name: consumedShip ? (consumedShip.name ?? null) : null,
    });
    const entryId = `c_${id}`;
    await env.DB
      .prepare(
        `INSERT INTO chronicle_entries
          (id, game_id, tick_number, kind, actor_faction_id, body_id, payload, visibility, created_at_ms)
         VALUES (?, ?, ?, 'settlement_built', ?, ?, ?, 'public', ?)`,
      )
      .bind(entryId, gameId, tick, me.id, bodyId, payload, Date.now())
      .run();
  } catch (e) {
    console.error('settlement_built chronicle insert failed', e);
  }

  return json({ settlement: { id, body_id: bodyId, type, name, hp, hp_max: hp } }, { status: 201 });
}

// Mirror of src/game/techs.ts TECH_DEFS. Server-authoritative so a client
// can't lie about cost. costForNext(level) = ceil(baseCost * (level+1)^scaling).
const TECH_DEFS = {
  weapons:      { baseCost: 40, costScaling: 1.7 },
  armor:        { baseCost: 40, costScaling: 1.7 },
  propulsion:   { baseCost: 35, costScaling: 1.6 },
  // Flight Dynamics scrapped — speed now comes from engine parts scaled by
  // Propulsion. A research request for 'flight' now falls through to the
  // unknown-tech rejection below.
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

  // (Flight Dynamics used to stamp faction.engine_g here. That tech is
  // scrapped — base acceleration is now fixed and speed comes from engine
  // parts scaled by Propulsion, so nothing bumps engine_g anymore.)

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

// Admin: publish The Orbital Herald now (host-only).
// POST /api/games/:gameId/admin/digest-now
// Fires the Discord digest for this game immediately, bypassing the
// once-per-day gate. A quiet day still posts a short all-quiet special
// edition so the button visibly works. Returns { posted, events, reason? }.
// 403 non-host; 409 webhook_not_configured when the secret is absent.
async function handleDigestNow(req, env, ctx) {
  const { gameId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const room = await env.DB
    .prepare('SELECT host_id, name FROM rooms WHERE id = ?')
    .bind(gameId)
    .first();
  if (!room || room.host_id !== ctx.session.user_id) {
    return err(403, 'not_host', 'only the host can publish the digest');
  }

  const game = await env.DB
    .prepare('SELECT id, current_tick FROM games WHERE id = ?')
    .bind(gameId)
    .first();
  if (!game) return err(404, 'not_found', 'game not found');

  const result = await runDigestForGame(
    env,
    { id: game.id, current_tick: game.current_tick, name: room.name },
    { force: true },
  );
  if (result.reason === 'webhook_not_configured') {
    return err(409, 'webhook_not_configured', 'DISCORD_DIGEST_WEBHOOK secret is not set on the worker');
  }
  return json({ ok: true, ...result });
}

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
// Charges COLLECTOR_COST (150 credits) and flips
// has_collector = 1 atomically. Failure modes:
//   404 not_found          — settlement missing or different game
//   403 not_owner          — settlement belongs to a different faction
//   409 already_collector  — settlement already has one
//   409 insufficient_resources — pool can't cover the cost
//
// Capitals already have has_collector = 1 from seedGameWorld so the
// "already_collector" guard catches the no-op double-build attempt.
//
// Must match src/game/settlements.ts COLLECTOR_COST — the client cost
// label reads the constant from there. Drift between the two = client
// shows N, server charges M, players see "insufficient_resources"
// errors on what looked like an affordable build.
const COLLECTOR_COST = { metal: 0, gold: 150 };

// Settlement upgrade buildings — server mirror of BUILDING_DEFS in
// src/game/settlements.ts. KEEP IN SYNC. Cost compounds geometrically
// per current level; build time compounds mildly.
//
//   cost   = floor(baseCost * costScaling^currentLevel)
//   ticks  = ceil(baseBuildTicks * buildTimeScaling^currentLevel)
//
// (server columns are metal/gold; client uses ore/credits — same thing,
// different name.)
// ECONOMY REWORK (DESIGN-identity-economy.md §1.2): each yield building
// costs the resource it PRODUCES, so compounding is self-limiting.
// The old cross-feed (forge cost gold, mint cost metal) formed a closed
// positive-feedback loop that left science 2.5x behind by endgame.
// Lab gets parity (+25%, 20 ticks — see room.js LAB_PER_LEVEL) and can
// host on stations (the ×1.4-science settlement type).
const BUILDING_DEFS = {
  forge:    { hostType: 'city',    base: { fuel: 0, metal: 40, gold: 0  }, costScaling: 1.6, baseTicks: 20, timeScaling: 1.3 },
  mint:     { hostType: 'city',    base: { fuel: 0, metal: 0,  gold: 40 }, costScaling: 1.6, baseTicks: 20, timeScaling: 1.3 },
  lab:      { hostType: 'any',     base: { fuel: 0, metal: 0,  gold: 40 }, costScaling: 1.6, baseTicks: 20, timeScaling: 1.3 },
  weapons:  { hostType: 'station', base: { fuel: 0, metal: 30, gold: 20 }, costScaling: 1.6, baseTicks: 30, timeScaling: 1.3 },
  shipyard: { hostType: 'station', base: { fuel: 0, metal: 50, gold: 30 }, costScaling: 1.7, baseTicks: 40, timeScaling: 1.3 },
  // Trajectory Control Thrusters — asteroid-weapon enabler. Mirrors
  // src/game/settlements.ts BUILDING_DEFS. hostBodyType restricts the
  // queueBuilding endpoint to rogue-asteroid bodies; without this an
  // unsanctioned POST could light Earth/Mars up with thrusters.
  trajectory_thrusters: {
    hostType: 'city',
    hostBodyType: 'asteroid',
    base: { fuel: 0, metal: 800, gold: 1200 },
    costScaling: 99,   // single-level — impossibly expensive at L2
    baseTicks: 40,
    timeScaling: 1,
  },
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
  if (BUILDING_DEFS[kind].hostType !== 'any' && settlement.type !== BUILDING_DEFS[kind].hostType) {
    return err(409, 'wrong_host', `${kind} requires a ${BUILDING_DEFS[kind].hostType}`);
  }
  // Body-type gate (e.g. trajectory_thrusters → asteroid only). Without
  // this a hand-crafted POST could queue an asteroid-only building on
  // a normal planet city.
  if (BUILDING_DEFS[kind].hostBodyType) {
    const host = await env.DB
      .prepare('SELECT type FROM game_bodies WHERE id = (SELECT body_id FROM game_settlements WHERE id = ?)')
      .bind(settlementId)
      .first();
    if (!host || host.type !== BUILDING_DEFS[kind].hostBodyType) {
      return err(409, 'wrong_body_type', `${kind} requires a ${BUILDING_DEFS[kind].hostBodyType} body`);
    }
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
    // Persist cost so resolveAsteroidImpacts (and any future
    // settlement-destruction path) can refund the in-flight upgrade.
    // Without this the refund block reads order?.cost as undefined and
    // silently keeps the materials.
    cost: { ore: cost.metal, credits: cost.gold },
  };

  // Local-first spend: drain this settlement's stockpile before
  // touching the faction pool.
  const stockRow = await env.DB
    .prepare('SELECT stockpile_metal, stockpile_gold FROM game_settlements WHERE id = ?')
    .bind(settlementId).first();
  const localMetal = Number(stockRow?.stockpile_metal ?? 0);
  const localGold  = Number(stockRow?.stockpile_gold  ?? 0);
  if (localMetal + me.metal < cost.metal || localGold + me.gold < cost.gold) {
    return err(409, 'insufficient_resources', `need ${cost.metal}M ${cost.gold}G (LOCAL+pool)`);
  }
  const takeLocalMetal = Math.min(cost.metal, localMetal);
  const takeLocalGold  = Math.min(cost.gold,  localGold);
  const takePoolMetal  = cost.metal - takeLocalMetal;
  const takePoolGold   = cost.gold  - takeLocalGold;

  const batchStmts = [
    env.DB
      .prepare(
        `UPDATE game_settlements
            SET building_order_json = ?,
                stockpile_metal = stockpile_metal - ?,
                stockpile_gold  = stockpile_gold  - ?
          WHERE id = ?`,
      )
      .bind(JSON.stringify(order), takeLocalMetal, takeLocalGold, settlementId),
  ];
  if (takePoolMetal > 0 || takePoolGold > 0) {
    batchStmts.push(
      env.DB
        .prepare('UPDATE game_factions SET metal = metal - ?, gold = gold - ? WHERE id = ?')
        .bind(takePoolMetal, takePoolGold, me.id),
    );
  }
  await env.DB.batch(batchStmts);

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

  // Refund cost-at-queue-time. Guarded flip (building_order_json still
  // set) + refund-only-if-changed (see handleCancelBuild) so two
  // concurrent cancels can't both refund.
  const refund = buildingCostAt(order.kind, Math.max(0, (order.target_level ?? 1) - 1));
  const flip = await env.DB
    .prepare('UPDATE game_settlements SET building_order_json = NULL WHERE id = ? AND building_order_json IS NOT NULL')
    .bind(settlementId)
    .run();
  if (!flip.meta?.changes) return err(409, 'already_cancelled', 'nothing to cancel');
  await env.DB
    .prepare('UPDATE game_factions SET metal = metal + ?, gold = gold + ? WHERE id = ?')
    .bind(refund?.metal ?? 0, refund?.gold ?? 0, me.id)
    .run();
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

  // Local-first spend: a stockpile-rich settlement can self-fund its
  // own promotion to collector status. Once the collector flips on,
  // the 90%/tick stockpile growth stops — so this is a one-time
  // "graduate the bank" moment that feels great.
  const stockRow = await env.DB
    .prepare('SELECT stockpile_metal, stockpile_gold FROM game_settlements WHERE id = ?')
    .bind(settlementId).first();
  const localMetal = Number(stockRow?.stockpile_metal ?? 0);
  const localGold  = Number(stockRow?.stockpile_gold  ?? 0);
  if (localMetal + me.metal < COLLECTOR_COST.metal || localGold + me.gold < COLLECTOR_COST.gold) {
    return err(409, 'insufficient_resources',
      `need ${COLLECTOR_COST.metal} ore + ${COLLECTOR_COST.gold} credits (LOCAL+pool)`);
  }
  const takeLocalMetal = Math.min(COLLECTOR_COST.metal, localMetal);
  const takeLocalGold  = Math.min(COLLECTOR_COST.gold,  localGold);
  const takePoolMetal  = COLLECTOR_COST.metal - takeLocalMetal;
  const takePoolGold   = COLLECTOR_COST.gold  - takeLocalGold;

  const game = await env.DB.prepare('SELECT current_tick FROM games WHERE id = ?').bind(gameId).first();
  const tick = game?.current_tick ?? 0;

  const batchStmts = [
    env.DB
      .prepare(
        `UPDATE game_settlements
            SET has_collector = 1,
                collector_built_tick = ?,
                stockpile_metal = stockpile_metal - ?,
                stockpile_gold  = stockpile_gold  - ?
          WHERE id = ?`,
      )
      .bind(tick, takeLocalMetal, takeLocalGold, settlementId),
  ];
  if (takePoolMetal > 0 || takePoolGold > 0) {
    batchStmts.push(
      env.DB
        .prepare('UPDATE game_factions SET metal = metal - ?, gold = gold - ? WHERE id = ?')
        .bind(takePoolMetal, takePoolGold, me.id),
    );
  }
  await env.DB.batch(batchStmts);

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
  // Guarded flip + refund-only-if-changed (see handleCancelBuild) so two
  // concurrent cancels can't both refund the cargo.
  const flip = await env.DB
    .prepare('UPDATE game_trade_routes SET cancelled_at_tick = ?, cargo_fuel = 0, cargo_metal = 0, cargo_gold = 0, cargo_science = 0 WHERE id = ? AND cancelled_at_tick IS NULL')
    .bind(tick, routeId)
    .run();
  if (!flip.meta?.changes) return err(409, 'already_cancelled', 'already cancelled');
  await env.DB
    .prepare('UPDATE game_factions SET fuel = fuel + ?, metal = metal + ?, gold = gold + ?, science = science + ? WHERE id = ?')
    .bind(fuel, metal, gold, science, me.id)
    .run();

  return json({ ok: true, refund: { fuel, metal, gold, science } });
}

// === Dyson Sphere — Engineering Victory ====================
//
// Foundation = a player-owned station orbiting Sol. First initiate
// claims the per-game slot. The per-tick delivery + damage logic
// runs server-side in worker/room.js resolveTick.

// Fuel left the economy (yields zeroed, income 0) — a fuel component
// here would make the sphere permanently uncompletable, killing the
// Engineering Victory in every new game. Field stays for schema shape;
// MUST be 0. Mirror: src/game/dysonSphere.ts DYSON_TARGET.
const DYSON_TARGET = {
  fuel: 0,
  ore: 15_000,
  credits: 15_000,
  science: 10_000,
};
const DYSON_MAX_HP =
  DYSON_TARGET.fuel + DYSON_TARGET.ore + DYSON_TARGET.credits + DYSON_TARGET.science;

// POST /api/games/:gameId/dyson/initiate
// body: { foundation_settlement_id }
// Caller must own a station at Sol matching foundation_settlement_id.
// No resource cost — the cost is in the per-tick freighter drain.
async function handleInitiateDyson(req, env, ctx) {
  const { gameId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return err(400, 'bad_request', 'invalid body');
  const stationId = body.foundation_settlement_id;
  if (typeof stationId !== 'string') {
    return err(400, 'bad_request', 'foundation_settlement_id required');
  }

  // Slot check — only one sphere per match.
  const game = await env.DB
    .prepare('SELECT dyson_controller_faction_id FROM games WHERE id = ?')
    .bind(gameId)
    .first();
  if (game?.dyson_controller_faction_id) {
    return err(409, 'slot_taken', 'a Dyson Sphere is already under construction this match');
  }

  // Settlement validity.
  const station = await env.DB
    .prepare(
      `SELECT id, owner_faction_id, body_id, type, destroyed_at_tick
         FROM game_settlements WHERE id = ? AND game_id = ?`,
    )
    .bind(stationId, gameId)
    .first();
  if (!station) return err(404, 'not_found', 'station not found');
  if (station.destroyed_at_tick != null) return err(409, 'destroyed', 'station is destroyed');
  // Column is owner_faction_id (not faction_id — the phantom column that
  // 500'd this endpoint on every call), and body ids are game-namespaced
  // as `${gameId}:sol` (not the bare literal 'sol' that always 409'd).
  if (station.owner_faction_id !== me.id) return err(403, 'not_owner', 'not your station');
  if (station.type !== 'station') return err(409, 'not_a_station', 'foundation must be a station');
  if (station.body_id !== `${gameId}:sol`) return err(409, 'not_at_sol', 'foundation must orbit Sol');

  const gameRow = await env.DB
    .prepare('SELECT current_tick FROM games WHERE id = ?')
    .bind(gameId)
    .first();
  const tick = gameRow?.current_tick ?? 0;

  await env.DB
    .prepare(
      `UPDATE games SET
         dyson_controller_faction_id = ?,
         dyson_foundation_settlement_id = ?,
         dyson_started_at_tick = ?,
         dyson_acc_fuel = 0, dyson_acc_ore = 0, dyson_acc_credits = 0, dyson_acc_science = 0,
         dyson_target_fuel = ?, dyson_target_ore = ?, dyson_target_credits = ?, dyson_target_science = ?,
         dyson_hp = 0, dyson_max_hp = ?
       WHERE id = ?`,
    )
    .bind(
      me.id, stationId, tick,
      DYSON_TARGET.fuel, DYSON_TARGET.ore, DYSON_TARGET.credits, DYSON_TARGET.science,
      DYSON_MAX_HP,
      gameId,
    )
    .run();

  return json({
    ok: true,
    dyson: {
      controllerFactionId: me.id,
      foundationSettlementId: stationId,
      startedAtTick: tick,
      maxHp: DYSON_MAX_HP,
      target: DYSON_TARGET,
    },
  }, { status: 201 });
}

// ============================================================
// POST /api/games/:gameId/bodies/:bodyId/ram
// body: { target_body_id, start_pos:{x,y}, start_vel:{x,y},
//         intercept_pos:{x,y}, flip_tick, arrive_tick, acceleration,
//         total_dv, fuel_cost }
//
// Trigger the asteroid-weapon RAM action. The asteroid `bodyId` has
// already had a Trajectory Control Thrusters building constructed at
// it (validated below); the caller's faction is the building's owner.
// On commit the asteroid leaves its natural orbit and begins a torch
// transit toward `target_body_id`. The on-tick resolver detects
// arrival and applies the impact effects (settlements destroyed,
// yields halved, asteroid removed).
//
// The plan is computed client-side (same shape as ship transfers —
// avoids duplicating the torch math on the server). The server
// validates the inputs are sane, the body is a settable asteroid
// owned by the caller's faction, the TT building is present, and
// the caller has enough fuel.
//
// Once written, the doom clock is on. There is no abort endpoint.
// ============================================================
async function handleRamAsteroid(req, env, ctx) {
  const { gameId, bodyId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  if (!BODY_ID_RE.test(bodyId)) return err(400, 'bad_request', 'invalid body id');

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const body = await env.DB
    .prepare(
      `SELECT id, type, owner_faction_id, ram_target_body_id, destroyed_at_tick
         FROM game_bodies
        WHERE id = ? AND game_id = ?`,
    )
    .bind(bodyId, gameId)
    .first();
  if (!body) return err(404, 'not_found', 'asteroid not found');
  if (body.destroyed_at_tick != null) return err(409, 'destroyed', 'asteroid already destroyed');
  if (body.type !== 'asteroid') {
    return err(409, 'wrong_type', 'only rogue asteroid bodies can be rammed');
  }
  if (body.ram_target_body_id) {
    return err(409, 'already_ramming', 'this asteroid already has a ram in flight');
  }

  // Caller must own a settlement here AND that settlement must carry
  // the trajectory_thrusters building at level >= 1.
  const settlements = (await env.DB
    .prepare(
      `SELECT id, owner_faction_id, buildings_json
         FROM game_settlements
        WHERE game_id = ? AND body_id = ? AND destroyed_at_tick IS NULL`,
    )
    .bind(gameId, bodyId)
    .all()).results ?? [];
  const mySettlements = settlements.filter(s => s.owner_faction_id === me.id);
  if (mySettlements.length === 0) {
    return err(403, 'no_settlement', 'you need a settlement on this asteroid to ram');
  }
  const hasThrusters = mySettlements.some(s => {
    if (!s.buildings_json) return false;
    try {
      const bs = JSON.parse(s.buildings_json);
      return (bs?.trajectory_thrusters ?? 0) >= 1;
    } catch { return false; }
  });
  if (!hasThrusters) {
    return err(409, 'no_thrusters', 'Trajectory Control Thrusters must be built first');
  }

  const payload = await readJson(req);
  if (!payload || typeof payload !== 'object') return err(400, 'bad_request', 'invalid body');

  const targetBodyId = payload.target_body_id;
  if (typeof targetBodyId !== 'string' || !BODY_ID_RE.test(targetBodyId)) {
    return err(400, 'bad_request', 'invalid target_body_id');
  }
  if (targetBodyId === bodyId) return err(400, 'bad_request', 'cannot target self');
  const target = await env.DB
    .prepare('SELECT 1 AS x FROM game_bodies WHERE id = ? AND game_id = ? AND destroyed_at_tick IS NULL')
    .bind(targetBodyId, gameId)
    .first();
  if (!target) return err(404, 'not_found', 'target body not found');

  // Validate the plan envelope. Reject NaN, infinity, and obviously
  // out-of-range values. The client is trusted on the math (planTorch
  // already runs there) but the server is the source of truth for
  // fuel debit and tick timing.
  const num = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
  const startTick = num(payload.start_tick);
  const flipTick = num(payload.flip_tick);
  const arriveTick = num(payload.arrive_tick);
  const acceleration = num(payload.acceleration);
  const startPosX = num(payload.start_pos_x);
  const startPosY = num(payload.start_pos_y);
  const startVelX = num(payload.start_vel_x);
  const startVelY = num(payload.start_vel_y);
  const interceptPosX = num(payload.intercept_pos_x);
  const interceptPosY = num(payload.intercept_pos_y);
  const totalDv = num(payload.total_dv);
  // Ram is paid in METAL. It used to cost faction fuel, but P0 removed
  // fuel from the economy (yields 0, starting pool 0) — which silently
  // made the ram permanently unaffordable and bricked Trajectory Control
  // Thrusters, the 800M/1200G building whose whole purpose is this
  // action. Accepts the legacy `fuel_cost` field name from an older
  // client bundle so an in-flight tab doesn't 400.
  const metalCost = num(payload.metal_cost ?? payload.fuel_cost);
  if ([startTick, flipTick, arriveTick, acceleration, startPosX, startPosY,
       startVelX, startVelY, interceptPosX, interceptPosY, totalDv, metalCost]
      .some(v => v == null)) {
    return err(400, 'bad_request', 'plan fields missing or invalid');
  }
  if (arriveTick <= startTick) return err(400, 'bad_request', 'arrive_tick must follow start_tick');
  if (flipTick <= startTick || flipTick >= arriveTick) {
    return err(400, 'bad_request', 'flip_tick must lie between start and arrive');
  }
  if (acceleration <= 0) return err(400, 'bad_request', 'acceleration must be positive');
  if (metalCost < 0) return err(400, 'bad_request', 'metal_cost must be non-negative');

  // Metal debit. Atomic with the plan write below — if either fails,
  // the player keeps their metal.
  if ((me.metal ?? 0) < metalCost) {
    return err(409, 'insufficient_resources', `need ${metalCost} metal to ram, have ${me.metal ?? 0}`);
  }

  const game = await env.DB
    .prepare('SELECT current_tick FROM games WHERE id = ?')
    .bind(gameId)
    .first();
  const nowTick = game?.current_tick ?? 0;
  if (startTick < nowTick - 1) {
    return err(400, 'bad_request', 'start_tick is in the past');
  }

  await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE game_bodies
            SET ram_target_body_id = ?,
                ram_start_tick = ?,
                ram_flip_tick = ?,
                ram_arrive_tick = ?,
                ram_acceleration = ?,
                ram_start_pos_x = ?, ram_start_pos_y = ?,
                ram_start_vel_x = ?, ram_start_vel_y = ?,
                ram_intercept_pos_x = ?, ram_intercept_pos_y = ?,
                ram_total_dv = ?,
                ram_owned_by_faction_id = ?
          WHERE id = ? AND game_id = ?`,
      )
      .bind(
        targetBodyId, startTick, flipTick, arriveTick, acceleration,
        startPosX, startPosY, startVelX, startVelY,
        interceptPosX, interceptPosY, totalDv, me.id,
        bodyId, gameId,
      ),
    env.DB
      .prepare('UPDATE game_factions SET metal = metal - ? WHERE id = ?')
      .bind(metalCost, me.id),
    // Reputation hit. Asteroid weapons are atrocities — bypass
    // every diplomatic norm, broadcast their threat to everyone in
    // the system, and the launching faction takes the maximum
    // reputation penalty regardless of who the target is. -100
    // floored at -100 so a single attacker can keep ramming
    // without sinking to -1000.
    env.DB
      .prepare(`UPDATE game_factions SET reputation = MAX(reputation - 100, -100) WHERE id = ?`)
      .bind(me.id),
  ]);

  // Chronicle the launch — broadcasts to everyone, gives them ~arrive
  // ticks of warning. Atrocity-flavored entry; the Daily picks this
  // up automatically.
  try {
    const targetName = (await env.DB
      .prepare('SELECT name FROM game_bodies WHERE id = ? AND game_id = ?')
      .bind(targetBodyId, gameId)
      .first())?.name ?? '?';
    const ownName = (await env.DB
      .prepare('SELECT name FROM game_bodies WHERE id = ? AND game_id = ?')
      .bind(bodyId, gameId)
      .first())?.name ?? '?';
    const ticksToImpact = Math.ceil(arriveTick - nowTick);
    const id = `ram_${bodyId.slice(-8)}_${Math.random().toString(36).slice(2, 8)}`;
    await env.DB
      .prepare(
        `INSERT INTO chronicle_entries
          (id, game_id, tick_number, kind, actor_faction_id, body_id, payload, visibility, created_at_ms)
         VALUES (?, ?, ?, 'asteroid_launched', ?, ?, ?, 'public', ?)`,
      )
      .bind(
        id, gameId, nowTick, me.id, bodyId,
        JSON.stringify({
          asteroid_name: ownName,
          target_body_id: targetBodyId,
          target_name: targetName,
          ticks_to_impact: ticksToImpact,
          owner_faction_id: me.id,
        }),
        Date.now(),
      )
      .run();
  } catch (e) {
    // Chronicle is best-effort; don't fail the launch over it.
    console.error('ram chronicle failed', e);
  }

  return json({
    ok: true,
    body_id: bodyId,
    target_body_id: targetBodyId,
    arrive_at_tick: arriveTick,
    fuel_cost: fuelCost,
  }, { status: 201 });
}

// PATCH /api/games/:gameId/ships/orders
// body: { ship_ids: string[], stance?, retreat_hp_pct?, detonate_hp_pct? }
//
// Bulk standing-orders update (DESIGN-identity-economy.md §3). Fields are
// optional-but-at-least-one; an explicitly-null retreat/detonate value
// clears the threshold ("off"). Ownership is all-or-nothing: if ANY ship
// in the list is missing, destroyed, or owned by someone else, the whole
// request is rejected and no ship is touched.
const STANCES = new Set(['attack', 'defensive', 'hold']);
const RETREAT_PCTS = new Set([25, 50, 75]);
const DETONATE_PCTS = new Set([25, 50]);

async function handleSetShipOrders(req, env, ctx) {
  const { gameId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return err(400, 'bad_request', 'invalid body');

  const shipIds = body.ship_ids;
  if (!Array.isArray(shipIds) || shipIds.length === 0) {
    return err(400, 'bad_request', 'ship_ids must be a non-empty array');
  }
  if (shipIds.length > 200) {
    return err(400, 'bad_request', 'too many ships in one request (max 200)');
  }
  const uniqueIds = [...new Set(shipIds)];
  for (const id of uniqueIds) {
    if (typeof id !== 'string' || !SHIP_ID_RE.test(id)) {
      return err(400, 'bad_request', `invalid ship id: ${id}`);
    }
  }

  // Field validation. Distinguish "absent" (leave the column alone) from
  // "explicitly null" (clear the threshold / reset stance to default).
  const hasStance   = 'stance' in body;
  const hasRetreat  = 'retreat_hp_pct' in body;
  const hasDetonate = 'detonate_hp_pct' in body;
  if (!hasStance && !hasRetreat && !hasDetonate) {
    return err(400, 'bad_request', 'no order fields supplied');
  }
  let stance = null;
  if (hasStance) {
    if (body.stance !== null && !STANCES.has(body.stance)) {
      return err(400, 'bad_request', "stance must be 'attack', 'defensive', or 'hold'");
    }
    stance = body.stance; // null resets to default ('attack' behavior)
  }
  let retreatPct = null;
  if (hasRetreat && body.retreat_hp_pct !== null) {
    const v = Number(body.retreat_hp_pct);
    if (!RETREAT_PCTS.has(v)) {
      return err(400, 'bad_request', 'retreat_hp_pct must be null, 25, 50, or 75');
    }
    retreatPct = v;
  }
  let detonatePct = null;
  if (hasDetonate && body.detonate_hp_pct !== null) {
    const v = Number(body.detonate_hp_pct);
    if (!DETONATE_PCTS.has(v)) {
      return err(400, 'bad_request', 'detonate_hp_pct must be null, 25, or 50');
    }
    detonatePct = v;
  }

  // Ownership check for EVERY ship — all-or-nothing.
  const placeholders = uniqueIds.map(() => '?').join(',');
  const rows = (await env.DB
    .prepare(
      `SELECT id, owner_faction_id, status FROM game_ships
        WHERE game_id = ? AND id IN (${placeholders})`,
    )
    .bind(gameId, ...uniqueIds)
    .all()).results ?? [];
  const byId = new Map(rows.map(r => [r.id, r]));
  for (const id of uniqueIds) {
    const row = byId.get(id);
    if (!row || row.status !== 'active') {
      return err(404, 'not_found', `ship not found: ${id}`);
    }
    if (row.owner_faction_id !== me.id) {
      return err(403, 'not_owner', `you do not own ship ${id}`);
    }
  }

  // One UPDATE covering all ships. Only the supplied fields are written.
  const sets = [];
  const binds = [];
  if (hasStance)   { sets.push('stance = ?');          binds.push(stance); }
  if (hasRetreat)  { sets.push('retreat_hp_pct = ?');  binds.push(retreatPct); }
  if (hasDetonate) { sets.push('detonate_hp_pct = ?'); binds.push(detonatePct); }
  await env.DB
    .prepare(
      `UPDATE game_ships SET ${sets.join(', ')}
        WHERE game_id = ? AND id IN (${placeholders})`,
    )
    .bind(...binds, gameId, ...uniqueIds)
    .run();

  return json({
    ok: true,
    updated: uniqueIds.length,
    orders: {
      ...(hasStance ? { stance } : {}),
      ...(hasRetreat ? { retreat_hp_pct: retreatPct } : {}),
      ...(hasDetonate ? { detonate_hp_pct: detonatePct } : {}),
    },
  });
}

// PATCH /api/games/:gameId/ships/:shipId
// body: { name: string } — 1..32 chars after trim. Owner-gated; rejects
// destroyed ships. Player-driven rename for in-flight + parked hulls.
async function handleRenameShip(req, env, ctx) {
  const { gameId, shipId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  if (!SHIP_ID_RE.test(shipId)) return err(400, 'bad_request', 'invalid ship id');

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return err(400, 'bad_request', 'invalid body');
  if (typeof body.name !== 'string') return err(400, 'bad_request', 'name must be a string');
  const name = body.name.trim();
  if (name.length === 0) return err(400, 'bad_request', 'name required');
  if (name.length > 32) return err(400, 'bad_request', 'name too long (max 32 chars)');

  const ship = await env.DB
    .prepare('SELECT owner_faction_id, status FROM game_ships WHERE id = ? AND game_id = ?')
    .bind(shipId, gameId)
    .first();
  if (!ship) return err(404, 'not_found', 'ship not found');
  if (ship.owner_faction_id !== me.id) return err(403, 'not_owner', 'you do not own this ship');
  if (ship.status === 'destroyed') return err(409, 'destroyed', 'cannot rename a destroyed ship');

  await env.DB
    .prepare('UPDATE game_ships SET name = ? WHERE id = ?')
    .bind(name, shipId)
    .run();
  return json({ ok: true, id: shipId, name });
}

// PATCH /api/games/:gameId/settlements/:settlementId
// body: { name: string } — 1..32 chars after trim. Owner-gated; rejects
// destroyed settlements. Same shape as handleRenameShip.
async function handleRenameSettlement(req, env, ctx) {
  const { gameId, settlementId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  // Settlement IDs are server-generated (`${bodyId}:c` style) so the
  // DB lookup is the gate — no separate regex check is needed.

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return err(400, 'bad_request', 'invalid body');
  if (typeof body.name !== 'string') return err(400, 'bad_request', 'name must be a string');
  const name = body.name.trim();
  if (name.length === 0) return err(400, 'bad_request', 'name required');
  if (name.length > 32) return err(400, 'bad_request', 'name too long (max 32 chars)');

  const s = await env.DB
    .prepare('SELECT owner_faction_id, destroyed_at_tick FROM game_settlements WHERE id = ? AND game_id = ?')
    .bind(settlementId, gameId)
    .first();
  if (!s) return err(404, 'not_found', 'settlement not found');
  if (s.owner_faction_id !== me.id) return err(403, 'not_owner', 'you do not own this settlement');
  if (s.destroyed_at_tick != null) return err(409, 'destroyed', 'cannot rename a destroyed settlement');

  await env.DB
    .prepare('UPDATE game_settlements SET name = ? WHERE id = ?')
    .bind(name, settlementId)
    .run();
  return json({ ok: true, id: settlementId, name });
}

// PATCH /api/games/:gameId/chronicle/:entryId/flavor
// body: { flavor: string | null }
//   - non-empty string sets a custom flavor override (max 500 chars)
//   - null / empty string reverts to the generated flavor
// Permission: caller's faction must be the event's actor OR target,
// OR the caller is the room host. Last-write-wins.
async function handleEditChronicleFlavor(req, env, ctx) {
  const { gameId, entryId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return err(400, 'bad_request', 'invalid body');
  let flavor = null;
  if (typeof body.flavor === 'string') {
    const trimmed = body.flavor.trim();
    if (trimmed.length > 0) {
      if (trimmed.length > 500) return err(400, 'bad_request', 'flavor too long (max 500 chars)');
      flavor = trimmed;
    }
  } else if (body.flavor != null) {
    return err(400, 'bad_request', 'flavor must be a string or null');
  }

  const entry = await env.DB
    .prepare('SELECT actor_faction_id, target_faction_id FROM chronicle_entries WHERE id = ? AND game_id = ?')
    .bind(entryId, gameId)
    .first();
  if (!entry) return err(404, 'not_found', 'event not found');

  // Permission: party to the event, or host. game.id === room.id.
  const isParty = entry.actor_faction_id === me.id || entry.target_faction_id === me.id;
  let isHost = false;
  if (!isParty) {
    const room = await env.DB.prepare('SELECT host_id FROM rooms WHERE id = ?').bind(gameId).first();
    isHost = !!room && room.host_id === ctx.session.user_id;
  }
  if (!isParty && !isHost) {
    return err(403, 'not_party', 'only a faction involved in this event (or the host) can rewrite it');
  }

  if (flavor == null) {
    // Revert: clear the override + its attribution.
    await env.DB
      .prepare('UPDATE chronicle_entries SET flavor_override = NULL, flavor_edited_by = NULL, flavor_edited_at_ms = NULL WHERE id = ?')
      .bind(entryId)
      .run();
  } else {
    await env.DB
      .prepare('UPDATE chronicle_entries SET flavor_override = ?, flavor_edited_by = ?, flavor_edited_at_ms = ? WHERE id = ?')
      .bind(flavor, me.id, Date.now(), entryId)
      .run();
  }

  // Nudge other clients to refresh sooner than their next poll.
  try {
    await env.ROOM.get(env.ROOM.idFromName(gameId)).fetch('https://room/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'chronicle', event: 'flavor_edited', entry_id: entryId }),
    });
  } catch { /* best-effort */ }

  return json({ ok: true, entry_id: entryId, flavor, edited_by: flavor ? me.id : null });
}

// ============================================================
// Ship designer (DESIGN-identity-economy.md §2)
//
// GET    /api/games/:gid/designs           — caller's design library
// POST   /api/games/:gid/designs           — create (optionally set active)
// PATCH  /api/games/:gid/designs/:designId — rename / edit parts / set active
// DELETE /api/games/:gid/designs/:designId
// POST   /api/games/:gid/ships/:shipId/detonate — manual detonator trigger
//
// One ACTIVE design per (faction, ship_class) — enforced on every
// activate path by clearing siblings in the same batch. BUILD snapshots
// the active design's parts_json onto the order (handleQueueBuild).
// ============================================================

const DESIGN_NAME_MAX = 32;

function designToJson(row) {
  return {
    id: row.id,
    ship_class: row.ship_class,
    name: row.name,
    parts_json: row.parts_json ?? null,
    icon_variant: row.icon_variant ?? null,
    is_active: row.is_active === 1,
    created_at_ms: row.created_at_ms,
  };
}

async function handleListDesigns(req, env, ctx) {
  const { gameId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const rows = (await env.DB
    .prepare(
      `SELECT id, ship_class, name, parts_json, icon_variant, is_active, created_at_ms
         FROM game_ship_designs
        WHERE game_id = ? AND faction_id = ?
        ORDER BY created_at_ms ASC`,
    )
    .bind(gameId, me.id)
    .all()).results ?? [];
  return json({ designs: rows.map(designToJson) });
}

async function handleCreateDesign(req, env, ctx) {
  const { gameId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return err(400, 'bad_request', 'invalid body');

  const shipClass = body.ship_class;
  if (typeof shipClass !== 'string' || !SHIP_CLASSES.has(shipClass)) {
    return err(400, 'bad_request', 'invalid ship_class');
  }
  const name = (typeof body.name === 'string' ? body.name.trim() : '');
  if (name.length === 0) return err(400, 'bad_request', 'design name required');
  if (name.length > DESIGN_NAME_MAX) {
    return err(400, 'bad_request', `design name too long (max ${DESIGN_NAME_MAX} chars)`);
  }
  const v = validateParts(shipClass, body.parts ?? []);
  if (!v.ok) return err(400, 'bad_parts', v.error);
  let iconVariant = null;
  if (body.icon_variant != null) {
    if (typeof body.icon_variant !== 'string' || !/^[A-F]$/.test(body.icon_variant)) {
      return err(400, 'bad_request', 'invalid icon_variant');
    }
    iconVariant = body.icon_variant;
  }
  const setActive = body.set_active === true;

  // Soft cap so a rogue client can't fill the table: 12 designs per
  // class is far beyond any legitimate library.
  const countRow = await env.DB
    .prepare('SELECT COUNT(*) AS c FROM game_ship_designs WHERE game_id = ? AND faction_id = ? AND ship_class = ?')
    .bind(gameId, me.id, shipClass)
    .first();
  if ((countRow?.c ?? 0) >= 12) {
    return err(409, 'too_many_designs', 'design library full for this class (max 12) — delete one first');
  }

  const id = `dsn_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const partsJson = v.parts.length > 0 ? JSON.stringify(v.parts) : null;
  const now = Date.now();

  const stmts = [];
  if (setActive) {
    stmts.push(
      env.DB
        .prepare('UPDATE game_ship_designs SET is_active = 0 WHERE game_id = ? AND faction_id = ? AND ship_class = ?')
        .bind(gameId, me.id, shipClass),
    );
  }
  stmts.push(
    env.DB
      .prepare(
        `INSERT INTO game_ship_designs
          (id, game_id, faction_id, ship_class, name, parts_json, icon_variant, is_active, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, gameId, me.id, shipClass, name, partsJson, iconVariant, setActive ? 1 : 0, now),
  );
  await env.DB.batch(stmts);

  return json({
    design: {
      id, ship_class: shipClass, name, parts_json: partsJson,
      icon_variant: iconVariant, is_active: setActive, created_at_ms: now,
    },
  }, { status: 201 });
}

async function handlePatchDesign(req, env, ctx) {
  const { gameId, designId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const row = await env.DB
    .prepare(
      `SELECT id, faction_id, ship_class, name, parts_json, icon_variant, is_active, created_at_ms
         FROM game_ship_designs WHERE id = ? AND game_id = ?`,
    )
    .bind(designId, gameId)
    .first();
  if (!row) return err(404, 'not_found', 'design not found');
  if (row.faction_id !== me.id) return err(403, 'not_owner', 'not your design');

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return err(400, 'bad_request', 'invalid body');

  let name = row.name;
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') return err(400, 'bad_request', 'name must be a string');
    const trimmed = body.name.trim();
    if (trimmed.length === 0) return err(400, 'bad_request', 'design name required');
    if (trimmed.length > DESIGN_NAME_MAX) {
      return err(400, 'bad_request', `design name too long (max ${DESIGN_NAME_MAX} chars)`);
    }
    name = trimmed;
  }
  let partsJson = row.parts_json ?? null;
  if (body.parts !== undefined) {
    const v = validateParts(row.ship_class, body.parts ?? []);
    if (!v.ok) return err(400, 'bad_parts', v.error);
    partsJson = v.parts.length > 0 ? JSON.stringify(v.parts) : null;
  }
  let iconVariant = row.icon_variant ?? null;
  if (body.icon_variant !== undefined) {
    if (body.icon_variant === null) iconVariant = null;
    else if (typeof body.icon_variant === 'string' && /^[A-F]$/.test(body.icon_variant)) {
      iconVariant = body.icon_variant;
    } else {
      return err(400, 'bad_request', 'invalid icon_variant');
    }
  }

  // Editing a design NEVER mutates queued or completed ships — parts
  // were snapshot onto the build order at queue time (spec §2.3).
  const stmts = [];
  let isActive = row.is_active === 1;
  if (body.is_active === true && !isActive) {
    // One active design per (faction, class): clear siblings first.
    stmts.push(
      env.DB
        .prepare('UPDATE game_ship_designs SET is_active = 0 WHERE game_id = ? AND faction_id = ? AND ship_class = ?')
        .bind(gameId, me.id, row.ship_class),
    );
    isActive = true;
  } else if (body.is_active === false) {
    // Deactivate — builds fall back to the bare hull.
    isActive = false;
  }
  stmts.push(
    env.DB
      .prepare('UPDATE game_ship_designs SET name = ?, parts_json = ?, icon_variant = ?, is_active = ? WHERE id = ?')
      .bind(name, partsJson, iconVariant, isActive ? 1 : 0, designId),
  );
  await env.DB.batch(stmts);

  return json({
    design: {
      id: row.id, ship_class: row.ship_class, name, parts_json: partsJson,
      icon_variant: iconVariant, is_active: isActive, created_at_ms: row.created_at_ms,
    },
  });
}

async function handleDeleteDesign(req, env, ctx) {
  const { gameId, designId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const row = await env.DB
    .prepare('SELECT id, faction_id FROM game_ship_designs WHERE id = ? AND game_id = ?')
    .bind(designId, gameId)
    .first();
  if (!row) return err(404, 'not_found', 'design not found');
  if (row.faction_id !== me.id) return err(403, 'not_owner', 'not your design');

  // Deleting the active design is allowed — builds simply fall back to
  // the bare hull until another design is activated. Queued/completed
  // ships keep their snapshot.
  await env.DB.prepare('DELETE FROM game_ship_designs WHERE id = ?').bind(designId).run();
  return json({ ok: true, design_id: designId });
}

// POST /api/games/:gameId/ships/:shipId/detonate
//
// Manual detonator trigger (spec §2.2, decided 2026-07-17):
//   - damage = 50% of the ship's MAX HP per detonator part, scaled by
//     the owner's Weapons tech at HALF rate (+5%/lvl), stacking
//     additively across parts (2 detonators = 100% of max HP, etc.)
//   - hits EVERY in-orbit ship at the same body — INCLUDING the
//     owner's own ships. No treaty, stance, or faction filter. The
//     client UI carries the full-disclosure copy; the server just
//     executes exactly what the copy promised.
//   - the detonating ship is CONSUMED (destroyed) regardless of kills.
//   - chronicle kind 'ship_detonated' with ship_name, body, victims.
async function handleDetonateShip(req, env, ctx) {
  const { gameId, shipId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  if (!SHIP_ID_RE.test(shipId)) return err(400, 'bad_request', 'invalid ship id');

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const ship = await env.DB
    .prepare(
      `SELECT id, owner_faction_id, name, ship_class, parent_body_id,
              hp, hp_max, status, parts_json
         FROM game_ships WHERE id = ? AND game_id = ?`,
    )
    .bind(shipId, gameId)
    .first();
  if (!ship) return err(404, 'not_found', 'ship not found');
  if (ship.owner_faction_id !== me.id) return err(403, 'not_owner', 'you do not own this ship');
  if (ship.status !== 'active') return err(409, 'destroyed', 'ship is not active');

  // In-orbit only: a ship mid-burn has left the orbital plane — the
  // blast geometry (same-orbit shrapnel shell) doesn't apply.
  const inTransit = await env.DB
    .prepare("SELECT 1 AS x FROM game_ship_nodes WHERE ship_id = ? AND status = 'in_transit' LIMIT 1")
    .bind(shipId)
    .first();
  if (inTransit) return err(409, 'in_transit', 'cannot detonate mid-transfer — wait for arrival');

  const parts = parsePartsJson(ship.ship_class, ship.parts_json);
  const nDetonators = countPart(parts, 'detonator');
  if (nDetonators <= 0) return err(409, 'no_detonator', 'this ship carries no detonator');

  // Weapons tech at trigger time, HALF rate (spec §2.2).
  const weaponsRow = await env.DB
    .prepare("SELECT level FROM faction_techs WHERE game_id = ? AND faction_id = ? AND tech_id = 'weapons'")
    .bind(gameId, me.id)
    .first();
  const damage = detonatorDamage(ship.hp_max ?? 0, nDetonators, weaponsRow?.level ?? 0);

  const game = await env.DB.prepare('SELECT current_tick FROM games WHERE id = ?').bind(gameId).first();
  const tick = game?.current_tick ?? 0;

  // Victims: every ACTIVE ship in the same orbit (same parent body),
  // friend and foe alike — spec says no exceptions, and that includes
  // the caller's own fleet. In-transit ships (departed but not yet
  // arrived, still row-parented at the departure body) are excluded —
  // they're not "in this orbit" anymore.
  const victims = (await env.DB
    .prepare(
      `SELECT s.id, s.name, s.ship_class, s.owner_faction_id, s.hp
         FROM game_ships s
        WHERE s.game_id = ? AND s.parent_body_id = ? AND s.status = 'active'
          AND s.id != ?
          AND NOT EXISTS (
            SELECT 1 FROM game_ship_nodes n
             WHERE n.ship_id = s.id AND n.status = 'in_transit'
          )`,
    )
    .bind(gameId, ship.parent_body_id, shipId)
    .all()).results ?? [];

  const stmts = [
    // The ship is consumed. Always.
    env.DB
      .prepare("UPDATE game_ships SET hp = 0, status = 'destroyed', destroyed_at_tick = ? WHERE id = ?")
      .bind(tick, shipId),
  ];
  const victimSummaries = [];
  for (const v of victims) {
    const newHp = Math.max(0, (v.hp ?? 0) - damage);
    if (newHp <= 0) {
      stmts.push(
        env.DB
          .prepare("UPDATE game_ships SET hp = 0, status = 'destroyed', destroyed_at_tick = ? WHERE id = ?")
          .bind(tick, v.id),
      );
    } else {
      stmts.push(
        env.DB.prepare('UPDATE game_ships SET hp = ? WHERE id = ?').bind(newHp, v.id),
      );
    }
    victimSummaries.push({
      ship_id: v.id,
      ship_name: v.name,
      ship_class: v.ship_class,
      owner_faction_id: v.owner_faction_id,
      destroyed: newHp <= 0,
    });
  }
  await env.DB.batch(stmts);

  // Chronicle — public, so everyone at the body learns exactly what
  // happened (a detonation is not a subtle act).
  try {
    const bodyRow = await env.DB
      .prepare('SELECT name FROM game_bodies WHERE id = ?')
      .bind(ship.parent_body_id)
      .first();
    const facRows = (await env.DB
      .prepare('SELECT id, name FROM game_factions WHERE game_id = ?')
      .bind(gameId)
      .all()).results ?? [];
    const facName = new Map(facRows.map(f => [f.id, f.name]));
    const payload = JSON.stringify({
      ship_id: shipId,
      ship_name: ship.name,
      ship_class: ship.ship_class,
      body_name: bodyRow?.name ?? null,
      owner_faction_name: facName.get(me.id) ?? null,
      damage,
      detonators: nDetonators,
      victims: victimSummaries.map(v => ({
        ...v,
        owner_faction_name: facName.get(v.owner_faction_id) ?? null,
      })),
      destroyed_count: victimSummaries.filter(v => v.destroyed).length,
    });
    await env.DB
      .prepare(
        `INSERT INTO chronicle_entries
          (id, game_id, tick_number, kind, actor_faction_id, body_id, ship_id, payload, visibility, created_at_ms)
         VALUES (?, ?, ?, 'ship_detonated', ?, ?, ?, ?, 'public', ?)`,
      )
      .bind(`c_det_${shipId.slice(-10)}_${tick}`, gameId, tick, me.id,
            ship.parent_body_id, shipId, payload, Date.now())
      .run();
  } catch (e) {
    console.error('ship_detonated chronicle insert failed', e);
  }

  return json({
    ok: true,
    ship_id: shipId,
    damage,
    detonators: nDetonators,
    victims: victimSummaries,
  });
}

export const routes = [
  // Ship designer — design library CRUD + detonator trigger. Listed
  // before the generic /ships/:shipId PATCH so nothing shadows the
  // more specific paths.
  {
    method: 'GET',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/designs$/,
    auth: 'required',
    handle: handleListDesigns,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/designs$/,
    auth: 'required',
    handle: handleCreateDesign,
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/designs\/(?<designId>[^/]+)$/,
    auth: 'required',
    handle: handlePatchDesign,
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/designs\/(?<designId>[^/]+)$/,
    auth: 'required',
    handle: handleDeleteDesign,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/ships\/(?<shipId>[^/]+)\/detonate$/,
    auth: 'required',
    handle: handleDetonateShip,
  },
  {
    // MUST precede the rename route below — its (?<shipId>[^/]+) pattern
    // would otherwise swallow the literal path segment 'orders'.
    method: 'PATCH',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/ships\/orders$/,
    auth: 'required',
    handle: handleSetShipOrders,
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/ships\/(?<shipId>[^/]+)$/,
    auth: 'required',
    handle: handleRenameShip,
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/settlements\/(?<settlementId>[^/]+)$/,
    auth: 'required',
    handle: handleRenameSettlement,
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/chronicle\/(?<entryId>[^/]+)\/flavor$/,
    auth: 'required',
    handle: handleEditChronicleFlavor,
  },
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
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/admin\/digest-now$/,
    auth: 'required',
    handle: handleDigestNow,
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
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/dyson\/initiate$/,
    auth: 'required',
    handle: handleInitiateDyson,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/bodies\/(?<bodyId>[^/]+)\/ram$/,
    auth: 'required',
    handle: handleRamAsteroid,
  },
];
