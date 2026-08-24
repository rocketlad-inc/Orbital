import { buildCostFactors } from './buildCost.js';
import { holdCapFor } from './routeMath.js';
import { validateIconVariant } from './store.js';
import { logSpend } from './analytics.js';
import { recomputeBodyOwnership } from './factions.js';
import {
  validateParts, partsCost, parsePartsJson,
  countPart, detonatorDamage, refitFee, computeShipStats,
} from './shipDesigns.js';
import { rollCaptain, resolveCaptainOnDeath, AVATAR_IDS, RECRUIT_COST,
         shipsInCombat } from './captains.js';
import { runDigestForGame, composeHeraldForGame } from './digest.js';
import {
  factionTechLevels, gatingEnabled, hasFeature, lockedError,
  HULL_FEATURE, BUILDING_FEATURE, PART_FEATURE,
} from './researchUnlocks.js';
import {
  MEGASTRUCTURES, MEGA_BODY_TYPE, deriveSiteOrbit, soiHolderAt,
  isComplete, remainingFor, progressOf,
} from './megastructures.js';

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
  // CORVETTE REBALANCE (Lorne, pacing pass). At 20/16 and ten ticks a
  // yard could flood the map with hulls faster than an opponent could
  // answer, and swarm beat composition. Price doubled and build time +6
  // ticks (= +6 hours at the 1h cadence every live game runs).
  // MIRRORS HULL_COST in worker/shipDesigns.js and SHIP_CLASSES in
  // src/game/shipClasses.ts — priceMirrors.test.ts enforces the cost half.
  corvette:  { fuel: 0,  metal: 40,  gold: 32,  build_ticks: 16 },
  frigate:   { fuel: 0,  metal: 45,  gold: 36,  build_ticks: 20 },
  destroyer: { fuel: 0,  metal: 110, gold: 95,  build_ticks: 40 },
  freighter: { fuel: 0,  metal: 28,  gold: 20,  build_ticks: 15 },
  // Colony ship — consumable expansion hull (DESIGN-identity-economy §4).
  // ~3x freighter cost: it IS the price of founding a city (deploy
  // consumes the ship instead of charging SETTLEMENT_COST).
  colony:    { fuel: 0,  metal: 80, gold: 60, build_ticks: 15 },
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

/**
 * Research gate for a single feature.
 *
 * Returns null when the faction may proceed, or a ready-to-return 403
 * Response when the feature is still locked. Call sites read as:
 *
 *   const gate = await requireFeature(env, gameId, me.id, 'hull.frigate');
 *   if (gate) return gate;
 *
 * These checks are the AUTHORITY — the client greys locked options out,
 * but a stale bundle or a hand-rolled POST must not be able to build a
 * destroyer on turn one. Runs after ownership/validation and before any
 * resource spend, so a locked request costs the player nothing.
 *
 * Two reads per gated action (levels + the game's gating flag) is
 * deliberate: gating_enabled is per-game and immutable after seeding, so
 * this is cheap and always correct, and it keeps the grandfather path
 * (pre-existing games short-circuit to allowed) impossible to forget.
 */
async function requireFeature(env, gameId, factionId, feature) {
  if (!feature) return null;                        // ungated thing
  const isGated = await gatingEnabled(env, gameId);
  if (!isGated) return null;                        // pre-existing game
  const levels = await factionTechLevels(env, gameId, factionId);
  if (hasFeature(feature, levels, true)) return null;
  const e = lockedError(feature);
  return err(403, e.code, e.message);
}

/**
 * Research gate for a whole parts list, in ONE pair of reads.
 *
 * A design can name six part types; running requireFeature per part
 * would issue a dozen queries for one save. Rejects on the first locked
 * part so the message names something specific ("Energy Mount unlocks
 * at Weapons level 3") rather than a generic refusal.
 */
async function requireParts(env, gameId, factionId, parts) {
  if (!parts || parts.length === 0) return null;    // bare hull is free
  const isGated = await gatingEnabled(env, gameId);
  if (!isGated) return null;
  const levels = await factionTechLevels(env, gameId, factionId);
  for (const p of parts) {
    const feature = PART_FEATURE[typeof p === 'string' ? p : p?.type];
    if (feature && !hasFeature(feature, levels, true)) {
      const e = lockedError(feature);
      return err(403, e.code, e.message);
    }
  }
  return null;
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

  // A freighter on an active trade delivery is autopilot property —
  // the room tick owns its movement (worker/room.js pass 2d). Allowing
  // a manual transfer here would fight the autopilot: it re-plans the
  // proper leg every idle tick, so a detour just burns fuel forever.
  const onDelivery = await env.DB
    .prepare(`SELECT 1 AS x FROM trade_deliveries WHERE ship_id = ? AND resolved_at_tick IS NULL LIMIT 1`)
    .bind(shipId).first();
  if (onDelivery) {
    return err(409, 'on_delivery', 'this freighter is hauling a trade shipment — it flies itself until delivery');
  }

  const body = await readJson(req);
  if (!body || typeof body !== 'object') return err(400, 'bad_request', 'invalid body');
  const targetBodyId = body.target_body_id;
  if (typeof targetBodyId !== 'string' || !BODY_ID_RE.test(targetBodyId)) {
    return err(400, 'bad_request', 'invalid target_body_id');
  }
  const target = await env.DB
    .prepare(
      `SELECT mineral_kind FROM game_bodies
        WHERE id = ? AND game_id = ? AND destroyed_at_tick IS NULL`,
    )
    .bind(targetBodyId, gameId)
    .first();
  if (!target) return err(404, 'not_found', 'target body not found');

  // FOG HOLDS AT THE API, NOT JUST IN THE UI.
  //
  // Undiscovered rocks are withheld from /state, so a browser has
  // nothing to click — but the id is guessable ("<game>:mtr_belt_0") and
  // this endpoint took it happily. A raider could park on a rock they
  // had never surveyed, which quietly deletes the property the whole
  // discovery mechanic buys: a rock only YOU have found is a rock only
  // you can work. Found by driving the API as the rival faction; the
  // route-stop path already had this gate, the transfer path never did.
  //
  // 404, not 403: the correct answer for a body you cannot see is that
  // it does not exist, or the refusal itself confirms the rock is there.
  if (target.mineral_kind) {
    const seen = await env.DB
      .prepare(
        `SELECT 1 AS x FROM game_body_discoveries
          WHERE game_id = ? AND faction_id = ? AND body_id = ?`,
      )
      .bind(gameId, me.id, targetBodyId)
      .first();
    if (!seen) return err(404, 'not_found', 'target body not found');
  }

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

  // Launch plan (DESIGN-transit-combat.md stage 0). The client's torch
  // planner already produced startPos/startVel/accel/flip when it built
  // this intent; recording them here — at commit, immutably — is what
  // makes the ship's mid-flight position a pure function of tick that
  // server and every client evaluate identically. Same trust posture as
  // arrival_t above: ONE derivation, made by the planner, recorded once.
  // All-or-nothing: a partial plan is worse than none (a node without a
  // plan simply doesn't participate in transit combat), so unless all
  // six fields arrive finite and coherent, store NULLs and behave
  // exactly like a pre-flag commit from an older bundle.
  let plan = null;
  {
    const lx = Number(body.launch_x), ly = Number(body.launch_y);
    const lvx = Number(body.launch_vx), lvy = Number(body.launch_vy);
    const acc = Number(body.accel), flip = Number(body.flip_tick);
    const finite = [lx, ly, lvx, lvy, acc, flip].every(Number.isFinite);
    if (finite && acc > 0 && flip > scheduledT && (arrivalT == null || flip < arrivalT)) {
      plan = { lx, ly, lvx, lvy, acc, flip };
    }
  }

  // Rendezvous arc (migration 0090): burn / coast / burn to match a
  // moving ship, then fly its plan. Same all-or-nothing posture as the
  // launch plan — a half-stored manoeuvre would put a hull somewhere
  // neither side can reproduce, which is the one failure this whole
  // design exists to prevent. Requires the launch state too, since the
  // arcs are integrated from it.
  let rv = null;
  if (plan) {
    const ax = Number(body.rv_ax), ay = Number(body.rv_ay);
    const bx = Number(body.rv_bx), by = Number(body.rv_by);
    const meet = Number(body.rv_meet_tick);
    const follow = typeof body.rv_follow_ship_id === 'string' ? body.rv_follow_ship_id : null;
    const finite = [ax, ay, bx, by, meet].every(Number.isFinite);
    // The burns have to FIT: thrusting for longer than the trip lasts is
    // not a manoeuvre, it is a rounding error that got stored.
    const t1 = Math.hypot(ax, ay) / plan.acc;
    const t2 = Math.hypot(bx, by) / plan.acc;
    if (finite && follow && SHIP_ID_RE.test(follow)
        && meet > scheduledT && (arrivalT == null || meet <= arrivalT)
        && t1 + t2 <= (meet - scheduledT) + 1e-6) {
      rv = { ax, ay, bx, by, meet, follow };
    }
  }
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
  // A fresh route SUPERSEDES the ship's current one. Without this, each
  // /transfer just appended a node, so re-ordering an already-moving ship
  // left BOTH legs live — the alarm and different clients then disagreed
  // on where it was going (player report: owner redirected a colony from
  // Deimos to Umbriel, but another player kept seeing it inbound to
  // Deimos off the stale node). Cancel the ship's existing committed/
  // in-transit legs FIRST. Chained legs post with replace omitted/false
  // and are awaited after this one, so they append cleanly instead of
  // cancelling each other.
  if (body.replace === true) {
    await env.DB
      .prepare(
        `UPDATE game_ship_nodes SET status = 'cancelled'
          WHERE ship_id = ? AND status IN ('committed','in_transit')`,
      )
      .bind(shipId)
      .run();
  }
  const nodeId = `${shipId}:n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await env.DB
    .prepare(
      `INSERT INTO game_ship_nodes
        (id, game_id, ship_id, sequence, anchor_kind, target_body_id,
         scheduled_t, arrival_at_tick, dv_prograde, dv_normal, dv_radial, fuel_cost,
         launch_x, launch_y, launch_vx, launch_vy, accel, flip_tick,
         rv_ax, rv_ay, rv_bx, rv_by, rv_meet_tick, rv_follow_ship_id,
         status, committed_at_tick)
       SELECT ?, ?, ?,
              COALESCE((SELECT MAX(sequence) FROM game_ship_nodes WHERE ship_id = ?), -1) + 1,
              'absolute', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'committed',
              (SELECT current_tick FROM games WHERE id = ?)`,
    )
    .bind(
      nodeId, gameId, shipId, shipId, targetBodyId, scheduledT, arrivalT, dvP, dvN, dvR, fuelCost,
      plan?.lx ?? null, plan?.ly ?? null, plan?.lvx ?? null, plan?.lvy ?? null,
      plan?.acc ?? null, plan?.flip ?? null,
      rv?.ax ?? null, rv?.ay ?? null, rv?.bx ?? null, rv?.by ?? null,
      rv?.meet ?? null, rv?.follow ?? null,
      gameId,
    )
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
      `SELECT id, body_id, faction_id, ship_class, completes_at_tick, cancelled_at_tick,
              parts_json, rush_count, charge_json
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

  // ---- Refund from the CHARGE LEDGER (migration 0084) ----------------
  //
  // The refund used to re-derive a price from the base cost table and pay
  // all of it into the faction pool. Three ways that was wrong, all live:
  //
  //   1. LAUNDERING (the reported exploit). The queue spends local-first
  //      — a raw world's banked stockpile before the pool — so a build
  //      queued on a raw world and cancelled moved LOCAL resources into
  //      the GLOBAL pool. Repeatable at will, and it defeated the whole
  //      point of a raw world: its yield is meant to be stuck on-site
  //      until you terraform.
  //   2. MINTING. The queue charges ceil(price x buildCostMult) — host
  //      config x senate ship_build_cost_multiplier x Construction
  //      discount — and the refund ignored the multiplier. With a
  //      "Cheaper Ships" law at 0.5x you paid half and were refunded
  //      whole; queue-and-cancel printed resources.
  //   3. RUSH DRIFT. A rush costs base x mult x rushKnob, but the refund
  //      paid base x (1 + rush_count).
  //
  // All three were the same mistake: guessing instead of remembering.
  // Hand back exactly what was taken, to exactly the purse it came from.
  let ledger = null;
  try {
    ledger = order.charge_json ? JSON.parse(order.charge_json) : null;
  } catch { ledger = null; }

  // Refund the build cost. (fuel was removed from server-side build
  // cost gating, but we keep the column rounding-trip-safe.)
  const cost = SHIP_BUILD_COST[order.ship_class];
  // Parts were charged at queue time (snapshot of the active design) —
  // refund them too, or a cancelled fully-loaded destroyer would eat
  // the loadout price. Every rush paid the same hull+parts price AGAIN
  // (§3), so a rushed-then-cancelled order refunds (1 + rush_count)×
  // the base — cancelling never eats the rush fees.
  const orderParts = parsePartsJson(order.ship_class, order.parts_json);
  const orderPartsCost = partsCost(orderParts);
  const refundMul = 1 + Math.max(0, Number(order.rush_count ?? 0));
  const refundMetal = ((cost?.metal ?? 0) + orderPartsCost.metal) * refundMul;
  const refundGold = ((cost?.gold ?? 0) + orderPartsCost.gold) * refundMul;
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

  if (ledger) {
    // Local shares go back to the settlement that paid them. A settlement
    // that has since been destroyed or changed hands has no stockpile to
    // credit, so that share falls to the pool — those resources really
    // were paid, and there is nowhere else to put them. It is not a way
    // back into the exploit: it needs the settlement to be GONE, which
    // costs far more than the laundered stockpile was worth.
    let poolMetal = Number(ledger.pool?.metal ?? 0);
    let poolGold = Number(ledger.pool?.gold ?? 0);
    const stmts = [];
    const backToLocal = [];
    for (const l of (Array.isArray(ledger.local) ? ledger.local : [])) {
      const m = Number(l.metal ?? 0);
      const g = Number(l.gold ?? 0);
      if (m <= 0 && g <= 0) continue;
      const alive = await env.DB
        .prepare(
          `SELECT id FROM game_settlements
            WHERE id = ? AND game_id = ? AND owner_faction_id = ?
              AND destroyed_at_tick IS NULL`,
        )
        .bind(l.id, gameId, me.id).first();
      if (alive) {
        stmts.push(env.DB
          .prepare(
            `UPDATE game_settlements
                SET stockpile_metal = stockpile_metal + ?,
                    stockpile_gold  = stockpile_gold  + ?
              WHERE id = ?`,
          )
          .bind(m, g, l.id));
        backToLocal.push({ settlement_id: l.id, metal: m, gold: g });
      } else {
        poolMetal += m;
        poolGold += g;
      }
    }
    if (poolMetal > 0 || poolGold > 0) {
      stmts.push(env.DB
        .prepare('UPDATE game_factions SET metal = metal + ?, gold = gold + ? WHERE id = ?')
        .bind(poolMetal, poolGold, me.id));
    }
    if (stmts.length) await env.DB.batch(stmts);

    return json({
      ok: true,
      order_id: orderId,
      // Both purses, so the client can say where the money went instead of
      // showing a pool number that didn't move.
      refund: {
        metal: poolMetal + backToLocal.reduce((a, x) => a + x.metal, 0),
        gold: poolGold + backToLocal.reduce((a, x) => a + x.gold, 0),
        pool: { metal: poolMetal, gold: poolGold },
        local: backToLocal,
      },
    });
  }

  // LEGACY ORDER (queued before 0084): no ledger exists, and there is no
  // honest way to reconstruct what it paid — the multipliers in force at
  // queue time aren't recorded anywhere. Keep the old approximate refund
  // rather than guess a different wrong number. These drain out of the
  // table as pre-0084 orders finish or are cancelled.
  await env.DB
    .prepare('UPDATE game_factions SET metal = metal + ?, gold = gold + ? WHERE id = ?')
    .bind(refundMetal, refundGold, me.id)
    .run();

  return json({
    ok: true,
    order_id: orderId,
    refund: { metal: refundMetal, gold: refundGold, legacy: true },
  });
}

// POST /api/games/:gameId/builds/:orderId/rush  (DESIGN-fleet-economy §3)
//
// Pay the ship's full current price (hull + escalated parts, × the same
// senate/tech build multipliers the queue charged, × the rush_cost
// senate knob) to halve the REMAINING build time — ceil, floor of 1
// tick. Unlimited rushes per order; each rush rolls a 25% chance the
// hull is delivered at HALF health. The roll happens here, server-side,
// and is sticky on the order (a botched order can't get worse — no
// further rolls — and can't be un-botched). Cancel refunds every fee.
const RUSH_BOTCH_CHANCE = 0.25;
async function handleRushBuild(req, env, ctx) {
  const { gameId, orderId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const order = await env.DB
    .prepare(
      `SELECT id, body_id, faction_id, ship_class, ship_name, status,
              completes_at_tick, cancelled_at_tick, parts_json,
              rush_count, botched, charge_json
         FROM game_body_build_queue
        WHERE id = ? AND game_id = ?`,
    )
    .bind(orderId, gameId)
    .first();
  if (!order) return err(404, 'not_found', 'build order not found');
  if (order.faction_id !== me.id) return err(403, 'not_owner', 'not your build order');
  if (order.cancelled_at_tick != null) return err(409, 'already_cancelled', 'this build was cancelled');
  // Waiting orders have a placeholder schedule — there's no "remaining
  // time" to halve until promotion stamps one. Rushing the queue's
  // FRONT is the way to pull a waiting order forward.
  if (order.status !== 'building') return err(409, 'not_building', 'order is still waiting for a build slot');

  const game = await env.DB
    .prepare('SELECT current_tick FROM games WHERE id = ?')
    .bind(gameId)
    .first();
  const tick = game?.current_tick ?? 0;
  const remaining = Number(order.completes_at_tick) - tick;
  if (remaining <= 1) return err(409, 'already_imminent', 'ship completes next tick — nothing to rush');

  // Price: the same scaled ship price the queue charged (hull + the
  // order's parts snapshot, senate build multiplier, construction tech
  // discount), times the senate's rush knob.
  const cost = SHIP_BUILD_COST[order.ship_class];
  const orderParts = parsePartsJson(order.ship_class, order.parts_json);
  const orderPartsCost = partsCost(orderParts);
  const rushFactors = await buildCostFactors(env, gameId, me.id, tick);
  const costMult = rushFactors.mult * rushFactors.rush;
  const rushMetal = Math.ceil(((cost?.metal ?? 0) + orderPartsCost.metal) * costMult);
  const rushGold  = Math.ceil(((cost?.gold  ?? 0) + orderPartsCost.gold)  * costMult);

  // Charge FIRST, guarded on affordability, so two racing rushes can't
  // both slip under one balance check. changes=0 means broke.
  const charge = await env.DB
    .prepare(
      `UPDATE game_factions SET metal = metal - ?, gold = gold - ?
        WHERE id = ? AND metal >= ? AND gold >= ?`,
    )
    .bind(rushMetal, rushGold, me.id, rushMetal, rushGold)
    .run();
  if (!charge.meta?.changes) {
    return err(409, 'insufficient_resources', `rushing costs ${rushMetal}M ${rushGold}G`);
  }

  // The 25% botch roll — once per rush, but sticky: an already-botched
  // order stays botched without rolling again (can't get worse).
  const alreadyBotched = (order.botched ?? 0) === 1;
  const botchedNow = !alreadyBotched && Math.random() < RUSH_BOTCH_CHANCE;
  const newCompletes = tick + Math.max(1, Math.ceil(remaining / 2));

  // Guard on the schedule we read, so a double-submit that already
  // charged twice at least can't halve twice off the same baseline —
  // the second UPDATE misses and we refund its fee.
  const flip = await env.DB
    .prepare(
      `UPDATE game_body_build_queue
          SET completes_at_tick = ?, rush_count = rush_count + 1, botched = MAX(botched, ?)
        WHERE id = ? AND cancelled_at_tick IS NULL AND status = 'building'
          AND completes_at_tick = ?`,
    )
    .bind(newCompletes, botchedNow ? 1 : 0, orderId, order.completes_at_tick)
    .run();
  if (!flip.meta?.changes) {
    await env.DB
      .prepare('UPDATE game_factions SET metal = metal + ?, gold = gold + ? WHERE id = ?')
      .bind(rushMetal, rushGold, me.id)
      .run();
    return err(409, 'conflict', 'order changed underfoot — try again');
  }

  // Add the rush fee to the order's charge ledger (0084). A rush is
  // always charged to the POOL, so it accumulates there — and a cancel
  // after N rushes now hands back exactly what those rushes cost instead
  // of (base price x (1 + rush_count)), a number unrelated to the fees
  // actually paid once any senate/tech multiplier was in play.
  //
  // Guarded on charge_json still holding the value we read, so two racing
  // rushes cannot both add onto the same baseline and lose a fee. A miss
  // means the other request already banked its own fee; the order is
  // still correct, this one's fee is simply not refundable, which is the
  // safe direction to fail (never refunds more than was paid).
  try {
    const prev = order.charge_json ? JSON.parse(order.charge_json) : null;
    if (prev && prev.pool) {
      const next = JSON.stringify({
        ...prev,
        pool: {
          metal: Number(prev.pool.metal ?? 0) + rushMetal,
          gold: Number(prev.pool.gold ?? 0) + rushGold,
        },
      });
      await env.DB
        .prepare('UPDATE game_body_build_queue SET charge_json = ? WHERE id = ? AND charge_json IS ?')
        .bind(next, orderId, order.charge_json).run();
    }
  } catch (e) {
    // A ledger that failed to grow under-refunds a later cancel. Loud in
    // the log, never fatal to the rush the player already paid for.
    console.error('rush: charge ledger update failed', e, { orderId });
  }

  await logSpend(env, {
    gameId, factionId: me.id, category: 'ships',
    metal: rushMetal, gold: rushGold,
  });

  // Public chronicle ONLY on a botch — the herald wants the cautionary
  // tale, not every clean rush.
  if (botchedNow) {
    try {
      const body = await env.DB
        .prepare('SELECT name FROM game_bodies WHERE id = ?')
        .bind(order.body_id).first();
      const fac = await env.DB
        .prepare('SELECT name FROM game_factions WHERE id = ?')
        .bind(me.id).first();
      const payload = JSON.stringify({
        ship_name: order.ship_name ?? null,
        ship_class: order.ship_class,
        body_name: body?.name ?? null,
        faction_name: fac?.name ?? null,
        rush_count: Number(order.rush_count ?? 0) + 1,
      });
      await env.DB
        .prepare(
          `INSERT INTO chronicle_entries
            (id, game_id, tick_number, kind, actor_faction_id, body_id, payload, visibility, created_at_ms)
           VALUES (?, ?, ?, 'ship_rush_botched', ?, ?, ?, 'public', ?)`,
        )
        .bind(`c_rush_${orderId}_${tick}`, gameId, tick, me.id, order.body_id, payload, Date.now())
        .run();
    } catch (e) { console.error('ship_rush_botched chronicle insert failed', e); }
  }

  return json({
    ok: true,
    order_id: orderId,
    completes_at_tick: newCompletes,
    rush_count: Number(order.rush_count ?? 0) + 1,
    botched: alreadyBotched || botchedNow,
    cost: { metal: rushMetal, gold: rushGold },
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

// GET /api/games/:gameId/herald
//
// The in-game edition of the Orbital Herald (P4 polish): the same
// clustered, weighted, phrase-banked newspaper the Discord digest
// posts, composed read-only over the trailing 24h and returned as
// JSON for the client's reader panel. Members only; public chronicle
// rows only. Never touches digest_state, so the Discord cadence is
// unaffected however often players refresh their paper.
async function handleGetHerald(req, env, ctx) {
  const { gameId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');
  // The masthead's game title lives on `rooms`, not `games` — there is no
  // games.name column, so `SELECT id, name, current_tick FROM games` threw
  // D1_ERROR on every single request and the in-game paper never rendered
  // once. It threw ABOVE the try below, so players got a raw worker
  // exception with a stack trace instead of the friendly notice, and the
  // Discord digest kept working because discord.js joins rooms properly.
  // The lookups are inside the try now for the same reason.
  try {
    const game = await env.DB
      .prepare('SELECT id, current_tick FROM games WHERE id = ?')
      .bind(gameId)
      .first();
    if (!game) return err(404, 'not_found', 'game not found');
    const room = await env.DB
      .prepare('SELECT name FROM rooms WHERE id = ?')
      .bind(gameId)
      .first();
    const edition = await composeHeraldForGame(
      env, { id: game.id, current_tick: game.current_tick, name: room?.name ?? game.id },
    );
    return json({ edition });
  } catch (e) {
    console.error('herald compose failed', e);
    return err(500, 'compose_failed', 'the presses jammed — try again shortly');
  }
}

// POST /api/games/:gameId/bodies/:bodyId/build
// body: { ship_class, ship_name? }
// Validates: caller owns body, faction can pay. (shipyard_level gate was
// dropped — the column was declared with DEFAULT 0 in 0003_game_state.sql
// and nothing ever incremented it, so every MP build 409'd.)
/**
 * Charge a construction cost across LOCAL settlement stockpiles and then the
 * faction pool, without ever being able to take resources for an order that
 * doesn't happen.
 *
 * THE BUG THIS EXISTS FOR (Sean, 2026-08-12): "the game rejected my
 * construction for not having enough resources, but took my resources
 * anyway." Both build paths checked affordability against `me.metal` — a
 * snapshot read at the top of the request — and then debited with an
 * UNGUARDED `SET metal = metal - ?`. Two submits (a double tap, a retry, or
 * a ship queue racing a building) both passed the same stale check and both
 * debited, driving the pool NEGATIVE. The next legitimate build then failed
 * its affordability check for real, so the player saw a rejection with the
 * resources already gone. The rush path had been written correctly for
 * exactly this reason, and the tick's upkeep debit was hardened for it too;
 * construction was the last unguarded spender.
 *
 * Every debit here is GUARDED, so it can only apply if the money is actually
 * there. If any of them misses, the ones that landed are put back and the
 * caller is told to reject. Refunds are plain credits and cannot fail a
 * guard, so the unwind always completes.
 *
 * CALLERS MUST CREATE THE ORDER ONLY ON `{ ok: true }`. That ordering is the
 * whole guarantee: charge first, build second — so a rejection can never
 * leave the player poorer.
 *
 * @param drains [{ id, metal, gold }] per-settlement draws, already planned
 * @returns { ok: true } | { ok: false, reason: 'insufficient_resources' }
 */
async function chargeConstruction(env, { factionId, drains = [], poolMetal = 0, poolGold = 0 }) {
  const applied = [];
  const unwind = async () => {
    for (const d of applied) {
      try {
        if (d.kind === 'settlement') {
          await env.DB
            .prepare(
              `UPDATE game_settlements
                  SET stockpile_metal = stockpile_metal + ?,
                      stockpile_gold  = stockpile_gold  + ?
                WHERE id = ?`,
            )
            .bind(d.metal, d.gold, d.id).run();
        } else {
          await env.DB
            .prepare('UPDATE game_factions SET metal = metal + ?, gold = gold + ? WHERE id = ?')
            .bind(d.metal, d.gold, factionId).run();
        }
      } catch (e) {
        // A failed unwind is the one outcome worse than the original bug, so
        // it is logged loudly with everything needed to repair it by hand.
        console.error('chargeConstruction: UNWIND FAILED', e, { factionId, refund: d });
      }
    }
  };

  for (const d of drains) {
    const m = Number(d.metal ?? 0);
    const g = Number(d.gold ?? 0);
    if (m <= 0 && g <= 0) continue;
    const res = await env.DB
      .prepare(
        `UPDATE game_settlements
            SET stockpile_metal = stockpile_metal - ?,
                stockpile_gold  = stockpile_gold  - ?
          WHERE id = ? AND stockpile_metal >= ? AND stockpile_gold >= ?`,
      )
      .bind(m, g, d.id, m, g).run();
    if (!res.meta?.changes) {
      await unwind();
      return { ok: false, reason: 'insufficient_resources' };
    }
    applied.push({ kind: 'settlement', id: d.id, metal: m, gold: g });
  }

  if (poolMetal > 0 || poolGold > 0) {
    const res = await env.DB
      .prepare(
        `UPDATE game_factions SET metal = metal - ?, gold = gold - ?
          WHERE id = ? AND metal >= ? AND gold >= ?`,
      )
      .bind(poolMetal, poolGold, factionId, poolMetal, poolGold).run();
    if (!res.meta?.changes) {
      await unwind();
      return { ok: false, reason: 'insufficient_resources' };
    }
    applied.push({ kind: 'pool', metal: poolMetal, gold: poolGold });
  }

  return { ok: true };
}

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
  // Hull gate. Corvette and colony are the starting kit and ungated
  // (HULL_FEATURE has no entry for them); freighter is Propulsion 1,
  // frigate Construction 3, destroyer Construction 4.
  const hullGate = await requireFeature(env, gameId, me.id, HULL_FEATURE[shipClass]);
  if (hullGate) return hullGate;
  // Player-picked icon variant from the BuildPanel dropdown. Validated
  // here so a malicious / outdated client can't write garbage to the
  // column. NULL is allowed and means "use the class default" — older
  // clients that don't post the field still work.
  let iconVariant = null;
  if (body.icon_variant !== undefined && body.icon_variant !== null) {
    // Premium letters (J-S) additionally require the cosmetics
    // entitlement — checked HERE, not just in the picker UI, because
    // the picker lock is decoration and this INSERT is the state.
    const badIcon = await validateIconVariant(env, ctx.session.user_id, body.icon_variant);
    if (badIcon) return err(badIcon.code === 'premium_required' ? 403 : 400, badIcon.code, badIcon.message);
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

  // Ship designer (§2) + curated build list: which loadout to snapshot.
  //   1. body.design_id — the build-list redesign sends the SPECIFIC
  //      design the row represents, so you can queue different loadouts
  //      of the same class back to back. Validated to the caller + class.
  //   2. body.bare === true — an explicit bare-hull build-list row; skip
  //      the active-design fallback entirely.
  //   3. neither (legacy clients) — fall back to the caller's ACTIVE
  //      design for this class, as before.
  // The chosen design's parts are SNAPSHOT onto the order here so later
  // edits to the design never mutate queued ships.
  let activeDesign = null;
  if (typeof body.design_id === 'string' && body.design_id.length > 0) {
    activeDesign = await env.DB
      .prepare(
        `SELECT id, parts_json, icon_variant FROM game_ship_designs
          WHERE id = ? AND game_id = ? AND faction_id = ? AND ship_class = ?
          LIMIT 1`,
      )
      .bind(body.design_id, gameId, me.id, shipClass)
      .first();
    if (!activeDesign) return err(404, 'not_found', 'design not found for this class');
  } else if (body.bare !== true) {
    activeDesign = await env.DB
      .prepare(
        `SELECT id, parts_json, icon_variant FROM game_ship_designs
          WHERE game_id = ? AND faction_id = ? AND ship_class = ? AND is_active = 1
          LIMIT 1`,
      )
      .bind(gameId, me.id, shipClass)
      .first();
  }
  const designParts = activeDesign ? parsePartsJson(shipClass, activeDesign.parts_json) : [];
  const designPartsJson = designParts.length > 0 ? JSON.stringify(designParts) : null;
  const designPartsCost = partsCost(designParts);
  // Icon fallback chain: explicit BuildPanel pick > design's variant >
  // class default (NULL). The design variant went through the same
  // 'A'..'F' validation at design-save time.
  if (iconVariant == null && activeDesign?.icon_variant && /^[A-S]$/.test(activeDesign.icon_variant)) {
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

  // Price dials — host config × senate ship_build_cost_multiplier ×
  // Construction discount. All three live in buildCost.js so the queue
  // path, the rush path, and the /state quote the client renders can't
  // drift apart. build_ticks is left alone: balance lever, not this dial.
  const tickRow = await env.DB
    .prepare('SELECT current_tick FROM games WHERE id = ?')
    .bind(gameId).first();
  const buildCostMult = (
    await buildCostFactors(env, gameId, me.id, tickRow?.current_tick ?? 0)
  ).mult;

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

  // THE CHARGE LEDGER (migration 0084). Cancel refunds from this record
  // rather than re-deriving a price, which is what let a raw world's
  // local stockpile launder into the global pool — and what made a
  // cheaper-ships law mint resources on queue-then-cancel. Written in the
  // same batch as the debits it describes, so the two cannot disagree.
  const chargeJson = JSON.stringify({
    pool: { metal: poolDrawMetal, gold: poolDrawGold },
    local: settlementDrains.map(d => ({ id: d.id, metal: d.metal, gold: d.gold })),
  });

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

  // CHARGE FIRST, guarded, and only build if the money actually moved. The
  // affordability check above reads a snapshot; between that read and here,
  // a second submit or the tick can have spent the same credits. See
  // chargeConstruction for the report this fixes.
  const charged = await chargeConstruction(env, {
    factionId: me.id,
    drains: settlementDrains,
    poolMetal: poolDrawMetal,
    poolGold: poolDrawGold,
  });
  if (!charged.ok) {
    return err(409, 'insufficient_resources',
      `Couldn't pay for this ship — ${scaledCost.metal} metal + ${scaledCost.gold} credits. `
      + 'Your balance changed while the order was being placed (another build, or the tick landing). '
      + 'Nothing was taken; check your purse and try again.');
  }

  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO game_body_build_queue
          (id, game_id, body_id, faction_id, ship_class, queued_at_tick, completes_at_tick, icon_variant, ship_name,
           parts_json, status, build_ticks, started_at_tick, charge_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(orderId, gameId, bodyId, me.id, shipClass, startTick, completeTick, iconVariant, shipName,
            designPartsJson, startsNow ? 'building' : 'waiting', cost.build_ticks, startsNow ? startTick : null,
            chargeJson),
    env.DB.prepare('INSERT INTO spend_events (game_id, faction_id, category, metal, gold, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)')
      // scaledCost, not cost: `cost` is the BARE HULL table price, while
      // the player is charged hull + fitted parts, the whole thing scaled
      // by buildCostMult (host config x senate multiplier x Construction
      // discount). Logging the base under-reported every armed ship ever
      // built — a fitted corvette charged 29 metal and recorded 20. The
      // gap only became visible once the Economy tab started deriving
      // income from pool movement and a build tick came out NEGATIVE.
      .bind(gameId, me.id, 'ships',
            Math.round(scaledCost.metal ?? 0), Math.round(scaledCost.gold ?? 0), Date.now()),
  ]);

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
/** Price of building a settlement on a body you ALREADY hold. The
 *  colony-ship path pays nothing here — the ship was the price.
 *  Exported so /state can quote it instead of the client hardcoding it
 *  (the world-menu button had `30` and `20` as literals in three
 *  places). */
export const SETTLEMENT_COST = { metal: 30, gold: 20 };
/** Colonist captain (DESIGN-captains §3) cuts founding cost by 20% when
 *  any of the caller's ships AT THE BODY carries the trait. Exported for
 *  the same reason: the button must gate on the price the server will
 *  actually charge, or it disables a legal action. */
export const COLONIST_FOUND_MULT = 0.8;

/** How many upgrades may wait BEHIND the one in progress at one
 *  settlement. Costs are charged when you queue, so an unbounded backlog
 *  is an unbounded pile of resources locked up behind a slow build. */
const BUILD_BACKLOG_MAX = 5;

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
  // STATIONS are the starting move now and stay ungated — a colony ship
  // has to be able to do something on turn one, and under the hard city
  // gate a station is the ONLY thing it can do on a raw world. CITIES
  // carry Construction 1 instead; they cannot be founded before a world
  // is terraformed anyway, so the level is nearly free by the time it
  // binds. (Was the other way round, which silently made all expansion
  // wait on research — 44-56 `claim_rej_not_researched` per arm in the
  // economy sweep.)
  if (type === 'city') {
    const gate = await requireFeature(env, gameId, me.id, 'settlement.city');
    if (gate) return gate;
  }

  const bodyRow = await env.DB
    .prepare('SELECT id, name, type, radius, owner_faction_id, terraformed_at_tick FROM game_bodies WHERE id = ? AND game_id = ? AND destroyed_at_tick IS NULL')
    .bind(bodyId, gameId)
    .first();
  if (!bodyRow) return err(404, 'not_found', 'body not found');

  // METEOROIDS TAKE NO SETTLEMENTS AT ALL. They are a few hundred metres
  // of rock on a loose orbit — there is nothing to anchor a station ring
  // to and nothing to stand a city on, and a permanent foothold would
  // also break the economics: the whole point of a rock is that working
  // it costs you a freighter's TIME (parked, defenceless, 50/tick into a
  // 500 hold) rather than a one-off construction bill. A station here
  // would turn a decaying resource into an outpost that mines itself.
  //
  // canHostCity already excludes the type client-side, but nothing
  // excluded stations — canHostStation returns true for every body,
  // because until now that was true. A colony ship could plant one on a
  // rock. This is the backstop; the client mirrors it.
  if (bodyRow.type === 'meteoroid') {
    return err(409, 'too_small',
      'meteoroids are too small to hold a settlement — work them with a '
      + 'freighter carrying a Mining Rig');
  }

  // Surface settlements require a landable surface — no gas giants or the star.
  if (type === 'city' && (bodyRow.type === 'star' || bodyRow.type === 'gas-giant' || bodyRow.type === 'ice-giant')) {
    return err(409, 'no_surface', 'cannot found a city on this body type');
  }

  // THE HARD GATE (DESIGN-terraforming): cities live on terraformed
  // worlds only. No soft fallback, no stunted raw-world city — a colony
  // ship arriving at a raw world deploys a station instead (the client
  // pre-selects it; this 409 is the backstop for stale/forged clients).
  if (type === 'city' && bodyRow.terraformed_at_tick == null) {
    return err(409, 'not_terraformed',
      'raw world — terraform it before founding a city (deploy a station instead)');
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
  //   city AND station: EITHER (a) you already own a settlement at this
  //            body → build for SETTLEMENT_COST (no ship needed), OR
  //            (b) consume a colony ship orbiting here (no resource cost).
  //            Path (b) is how a body with no presence of yours — gas
  //            giants, Sol, anything unclaimed — gets settled at all.
  //   Cities carry the extra terraformed gate (checked above); that is
  //   what keeps them expensive, not a second colony ship on a world you
  //   already hold.
  // A COLONY HULL CARRIES ONE MODULE AND IT DECIDES WHAT THE SHIP IS FOR.
  // The Colony Module founds settlements; the Construction Module lays
  // megastructure foundations. One slot, so fitting one excludes the
  // other, and a hull sent out to build a warp gate must not be quietly
  // spent founding a station instead.
  //
  // An EMPTY loadout still settles. Every colony ship that existed before
  // the modules did has parts_json NULL, and refusing those would strand
  // ships mid-flight in live games over a fitting that did not exist when
  // they launched.
  const colonyCandidates = (await env.DB
    .prepare(
      `SELECT id, name, ship_class, parts_json FROM game_ships
        WHERE game_id = ? AND owner_faction_id = ? AND parent_body_id = ?
          AND ship_class = 'colony'
          AND status = 'active'`,
    )
    .bind(gameId, me.id, bodyId)
    .all()).results ?? [];
  const colonyShip = colonyCandidates.find((c) => {
    const parts = parsePartsJson(c.ship_class, c.parts_json);
    return !parts.includes('construction');
  }) ?? null;

  let consumedShip = null; // { id, name } when a colony ship pays the bill
  let payResourceCost = false;
  let settleCost = { ...SETTLEMENT_COST }; // may be Colonist-discounted below

  // A foothold you ALREADY hold at this body is what the colony ship was
  // ever for — it buys the first landing, not every building after it.
  // Cities used to demand one unconditionally while stations accepted an
  // existing settlement, which read as arbitrary from the player's side:
  // terraform a moon (124M+124C), plant a station on it, and the game
  // still asked for an 80M+60C ship before you could put a city on the
  // ground you already own and already made habitable. Both types now run
  // the same two paths.
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
    // Colonist captain (DESIGN-captains §3): any of the caller's ships
    // at this body with a Colonist officer cuts founding cost 20%.
    // A ship already IN FLIGHT doesn't count, even though its
    // parent_body_id still names the body it departed (see room.js
    // "Ships actually IN FLIGHT don't fight"). Two reasons: an officer
    // who has left isn't overseeing the groundbreaking, and the client
    // excludes in-transit hulls when it quotes this price — if the two
    // disagreed, the button would gate on 30M while the server charged
    // 24M and grey out a build the server would have accepted.
    const colonistHere = await env.DB
      .prepare(
        `SELECT 1 AS x FROM game_ships s
           JOIN game_captains c ON c.id = s.captain_id
          WHERE s.game_id = ? AND s.parent_body_id = ? AND s.owner_faction_id = ?
            AND s.status = 'active' AND c.traits_json LIKE '%colonist%'
            AND NOT EXISTS (
              SELECT 1 FROM game_ship_nodes n
               WHERE n.ship_id = s.id AND n.status = 'in_transit')
          LIMIT 1`,
      )
      .bind(gameId, bodyId, me.id)
      .first();
    settleCost = colonistHere
      ? { metal: Math.ceil(SETTLEMENT_COST.metal * COLONIST_FOUND_MULT),
          gold:  Math.ceil(SETTLEMENT_COST.gold  * COLONIST_FOUND_MULT) }
      : { ...SETTLEMENT_COST };
    if (me.metal < settleCost.metal || me.gold < settleCost.gold) {
      return err(409, 'insufficient_resources',
        `need ${settleCost.metal}M ${settleCost.gold}G`);
    }
  } else if (colonyShip) {
    consumedShip = colonyShip;
  } else {
    return err(409, 'need_colony_ship',
      type === 'city'
        ? 'founding a city needs a settlement of yours at this body (pay metal/credits) or a Colony Ship in orbit (consumed)'
        : 'need a settlement of yours at this body (pay metal/credits) or a Colony Ship in orbit (consumed)');
  }

  const game = await env.DB.prepare('SELECT current_tick FROM games WHERE id = ?').bind(gameId).first();
  const tick = game?.current_tick ?? 0;

  const name = (typeof body.name === 'string' && body.name.trim())
    ? body.name.trim().slice(0, 40)
    : (type === 'city' ? 'New City' : 'Station');

  const id = `${bodyId}:${type[0]}${Date.now().toString(36)}`;
  // Base structure from the game's config (admin Editor), not a literal,
  // so it can be retuned without a deploy. Falls back to the shipped
  // values if the lookup fails — see gameConfig.js.
  let hpCfg = { city_base_hp: 300, station_base_hp: 400 };
  try {
    const gc = await import('./gameConfig.js');
    hpCfg = await gc.cfg(env, gameId);
  } catch (e) {
    console.error('settlement hp config lookup failed, using shipped values', e);
  }
  const hp = type === 'city' ? hpCfg.city_base_hp : hpCfg.station_base_hp;

  // Geometry: cities pick a random surface angle. Stations get a tight
  // circular orbit just above body.radius. The flat +3 is a floor, not the
  // whole rule: on a radius-50 star it would be a 6% gap and the station
  // would look embedded in the photosphere, so above radius ~13.6 the
  // clearance goes proportional. 22% sits deliberately between the star's
  // 10% occlusion disk and the 30% altitude ships park at, so a Sol station
  // is visible against the surface and still under its own fleet.
  const surfaceAngle = type === 'city' ? Math.random() * Math.PI * 2 : null;
  const bodyR = bodyRow.radius || 4;
  const rp = type === 'station' ? bodyR + Math.max(3, bodyR * 0.22) : null;

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
  // Charged BEFORE the batch and guarded, so a double submit can't deploy
  // two settlements for one payment (or overdraw the pool and make the NEXT
  // build report "insufficient" with the credits already gone).
  if (payResourceCost) {
    const paidDeploy = await env.DB
      .prepare(
        `UPDATE game_factions SET metal = metal - ?, gold = gold - ?
          WHERE id = ? AND metal >= ? AND gold >= ?`,
      )
      .bind(settleCost.metal, settleCost.gold, me.id, settleCost.metal, settleCost.gold)
      .run();
    if (!paidDeploy.meta?.changes) {
      return err(409, 'insufficient_resources',
        `deploying costs ${settleCost.metal} metal + ${settleCost.gold} credits — `
        + 'your balance changed while the request was in flight. Nothing was taken.');
    }
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
    // Its captain walks off onto the new colony rather than going down
    // with a hull that was never sunk. Without this they keep pointing at
    // a destroyed ship: not in the bank (ship_id is set), not serving
    // (the ship is gone), and shown as "on assignment" forever — the
    // limbo a player reported. No survival roll here; nobody died.
    deployStmts.push(
      env.DB
        .prepare(
          `UPDATE game_captains
              SET ship_id = NULL, benched_at_tick = NULL
            WHERE game_id = ? AND ship_id = ?`,
        )
        .bind(gameId, consumedShip.id),
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
//
// UNIFIED curve (15 × (level+1)^2.5) — must match src/game/techs.ts
// RESEARCH_BASE_COST / RESEARCH_COST_SCALING exactly. The old per-track
// curves (40/1.7 etc.) were retired client-side but left stale here, so the
// client bar filled at ~15 sci while the server ground on to ~40 — research
// looked "finished" then hung until the higher server cost was met. Keep
// these two tables in lockstep. L1 15 · L3 234 · L5 839 · L10 4744.
//
// Raised from 1.72 after Game 3: income compounds while a power curve's
// growth rate decays, so research accelerated instead of holding pace —
// every faction averaged level 7.18 by tick 441 with the tree fully spent.
// See the longer note in src/game/techs.ts for the calibration.
const RESEARCH_BASE_COST = 15;
const RESEARCH_COST_SCALING = 2.5;
const TECH_DEFS = {
  weapons:      { baseCost: RESEARCH_BASE_COST, costScaling: RESEARCH_COST_SCALING },
  armor:        { baseCost: RESEARCH_BASE_COST, costScaling: RESEARCH_COST_SCALING },
  // Flight Dynamics scrapped — speed now comes from engine parts scaled by
  // Propulsion. A research request for 'flight' now falls through to the
  // unknown-tech rejection below.
  propulsion:   { baseCost: RESEARCH_BASE_COST, costScaling: RESEARCH_COST_SCALING },
  construction: { baseCost: RESEARCH_BASE_COST, costScaling: RESEARCH_COST_SCALING },
  industry:     { baseCost: RESEARCH_BASE_COST, costScaling: RESEARCH_COST_SCALING },
  sensors:      { baseCost: RESEARCH_BASE_COST, costScaling: RESEARCH_COST_SCALING },
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

  // Research QUEUE (optional, independent of the project change). The
  // client sends the FULL desired queue each time — simplest, no
  // add/remove race. We keep only known tech ids, cap the length, and
  // persist as JSON. The per-tick pass promotes the head into
  // research_tech_id whenever research goes idle. A request may carry
  // `queue` alone (no tech_id), or `queue` + a tech_id / null together.
  let queueOut;
  if (Array.isArray(body.queue)) {
    queueOut = body.queue.filter(t => typeof t === 'string' && TECH_DEFS[t]).slice(0, 16);
    await env.DB
      .prepare('UPDATE game_factions SET research_queue = ? WHERE id = ?')
      .bind(JSON.stringify(queueOut), me.id)
      .run();
  }
  // Queue-only request (caller didn't ask to change the active project).
  if (techId === undefined) {
    return json({ queue: queueOut ?? [] });
  }

  // tech_id: null clears the project (research goes idle; science banks).
  if (techId === null) {
    await env.DB
      .prepare('UPDATE game_factions SET research_tech_id = NULL, research_progress = 0 WHERE id = ?')
      .bind(me.id)
      .run();
    return json({ tech_id: null, progress: 0 });
  }

  if (typeof techId !== 'string' || !TECH_DEFS[techId]) {
    return err(400, 'bad_request', 'invalid tech_id');
  }

  const cur = await env.DB
    .prepare('SELECT level FROM faction_techs WHERE game_id = ? AND faction_id = ? AND tech_id = ?')
    .bind(gameId, me.id, techId)
    .first();
  const curLevel = cur?.level ?? 0;

  if (curLevel >= TECH_MAX_LEVEL) {
    return err(409, 'tech_maxed', `${techId} is already at max level ${TECH_MAX_LEVEL}`);
  }

  // Committing to a project costs nothing up front, but BANKED science
  // is applied toward it the moment you commit — and if the bank covers
  // the whole remaining cost, the level completes instantly (an
  // insta-buy). After that, the per-tick drain in worker/room.js keeps
  // pouring science income into research_progress as before. Switching
  // to a DIFFERENT track abandons progress on the old one; re-picking
  // the current track preserves it (and re-applies any newly banked
  // science, so clicking your active project can also finish it).
  //
  // The project columns are fetched explicitly: requireMyFaction doesn't
  // select them, and the old code read them off `me` anyway — always
  // undefined, so `switching` was ALWAYS true and re-picking the current
  // track silently reset its progress, contrary to the comment on it.
  const projRow = await env.DB
    .prepare('SELECT research_tech_id, research_progress, name FROM game_factions WHERE id = ?')
    .bind(me.id)
    .first();
  const switching = (projRow?.research_tech_id ?? null) !== techId;
  const progress0 = switching ? 0 : Number(projRow?.research_progress ?? 0);

  // Same 3dp rounding discipline as the tick drain — income is
  // fractional and float noise otherwise drifts the pool/progress.
  const round3 = (n) => Math.round(n * 1000) / 1000;
  const cost = techCostForNext(curLevel, TECH_DEFS[techId]);
  const pool = Number(me.science ?? 0);
  const remaining = round3(cost - progress0);
  // Clamped to the pool and to what's still needed, exactly like the
  // drain: never spend science that isn't there, never overshoot.
  const spend = remaining > 0 ? Math.max(0, round3(Math.min(pool, remaining))) : 0;
  const newProgress = round3(progress0 + spend);

  if (newProgress >= cost) {
    // Bank covers it — grant the level NOW. Mirrors the tick drain's
    // completion branch (worker/room.js research pass): clear the
    // project so the next one is a deliberate choice, upsert the tech
    // level, and chronicle it.
    const game = await env.DB
      .prepare('SELECT current_tick FROM games WHERE id = ?')
      .bind(gameId)
      .first();
    const tick = game?.current_tick ?? 0;
    // An insta-buy of a tech that is NOT your active project is a pure
    // instant purchase: deduct the science, grant the level, and LEAVE the
    // active project + its progress untouched. Only clear the track when the
    // tech you just finished IS the one you were actively researching.
    //
    // Bug (StealthyMoose, iOS): this branch used to always NULL
    // research_tech_id + zero research_progress, so unlocking a side tech
    // (sensors, fully bank-covered) wiped an unrelated in-progress project
    // (propulsion at 14/15). Resuming re-applied banked science, which is
    // why the progress "came back" — it was never really preserved.
    const completionUpdate = switching
      ? env.DB
          .prepare('UPDATE game_factions SET science = science - ? WHERE id = ?')
          .bind(spend, me.id)
      : env.DB
          .prepare('UPDATE game_factions SET science = science - ?, research_tech_id = NULL, research_progress = 0 WHERE id = ?')
          .bind(spend, me.id);
    await env.DB.batch([
      completionUpdate,
      env.DB
        .prepare(
          `INSERT INTO faction_techs
            (game_id, faction_id, tech_id, status, level, started_at_tick, completed_at_tick)
           VALUES (?, ?, ?, 'completed', 1, ?, ?)
           ON CONFLICT(game_id, faction_id, tech_id) DO UPDATE
             SET level = level + 1, status = 'completed', completed_at_tick = ?`,
        )
        .bind(gameId, me.id, techId, tick, tick, tick),
    ]);
    try {
      // Level in the id: two insta-buys of successive levels of the SAME
      // tech can land on the same tick — the drain's id scheme (tick +
      // faction + tech) would collide and drop the second entry.
      await env.DB
        .prepare(
          `INSERT INTO chronicle_entries
            (id, game_id, tick_number, kind, actor_faction_id, payload, visibility, created_at_ms)
           VALUES (?, ?, ?, 'tech_advanced', ?, ?, 'public', ?)`,
        )
        .bind(
          `c${tick}_tech_${me.id.slice(-6)}_${techId}_l${curLevel + 1}`,
          gameId, tick, me.id,
          JSON.stringify({
            tech_id: techId,
            level: curLevel + 1,
            faction_name: projRow?.name ?? null,
          }),
          Date.now(),
        )
        .run();
    } catch (e) { console.error('tech_advanced chronicle failed (insta-buy)', e); }

    return json({
      tech_id: techId,
      level: curLevel + 1,
      progress: 0,
      cost,
      science_spent: spend,
      completed: true,
    }, { status: 201 });
  }

  await env.DB
    .prepare(
      `UPDATE game_factions
          SET science = science - ?, research_tech_id = ?, research_progress = ?
        WHERE id = ?`,
    )
    .bind(spend, techId, newProgress, me.id)
    .run();

  return json({
    tech_id: techId,
    level: curLevel,
    progress: newProgress,
    cost,
    science_spent: spend,
    completed: false,
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
//   body: { faction_id: string | 'all', ore?, credits?, science? }
// A `fuel` key is accepted by the parser and ignored — fuel is gone.
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
    .prepare('SELECT id, current_tick, status FROM games WHERE id = ?')
    .bind(gameId)
    .first();
  if (!game) return err(404, 'not_found', 'game not found');

  // A finished game publishes its FINAL edition: everything still
  // unpublished, not the button's usual rolling 12h window (which would
  // quietly drop the earlier part of the match's last day). Live games
  // keep the trailing window so the button always shows recent news.
  const result = await runDigestForGame(
    env,
    { id: game.id, current_tick: game.current_tick, name: room.name },
    game.status === 'completed' ? { final: true } : { force: true },
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
  // NO FUEL. body.fuel is ignored rather than honoured: this endpoint
  // was the last way to put fuel back into a live game — a host with a
  // stale client or a curl could re-seed a pool the purge had just
  // emptied, and nothing in the UI would ever show it again.
  const dOre = clamp(body.ore ?? 0);
  const dCredits = clamp(body.credits ?? 0);
  const dScience = clamp(body.science ?? 0);

  if (!dOre && !dCredits && !dScience) {
    return err(400, 'bad_request', 'all deltas were zero');
  }

  // Client uses ore/credits naming; server columns are metal/gold. Map here.
  // Pools floor at 0 (use MAX so subtractions can't dive negative).
  const sql = `UPDATE game_factions
                  SET metal   = MAX(0, metal   + ?),
                      gold    = MAX(0, gold    + ?),
                      science = MAX(0, science + ?)
                WHERE game_id = ?`;

  if (targetRaw === 'all') {
    await env.DB.prepare(sql + '').bind(dOre, dCredits, dScience, gameId).run();
  } else {
    await env.DB
      .prepare(sql + ' AND id = ?')
      .bind(dOre, dCredits, dScience, gameId, targetRaw)
      .run();
  }

  return json({
    ok: true,
    applied_to: targetRaw,
    delta: { ore: dOre, credits: dCredits, science: dScience },
  });
}

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
  // ORBITAL SHIELDS — cities only. Costs metal AND credits: it is the one
  // building that buys pure survivability, and pricing it in a single
  // resource would let whichever economy is strongest turtle for free.
  //
  // 'city' rather than 'any' is a deliberate design line: a shielded
  // station would let a player fortify orbit itself, and the whole point
  // of stations is that they are the exposed half of a holding. Ground is
  // what you protect; orbit is what you contest.
  // 2026-08-07 (Lorne): tripled base + steeper curve (1.7 -> 2.0). At
  // 45/45 x1.7 a max-shield turtle was cheaper than one destroyer; a
  // defence that strong has to cost like the fleet it replaces.
  shields:  { hostType: 'city',
              base: { fuel: 0, metal: 135, gold: 135 }, costScaling: 2.0, baseTicks: 35, timeScaling: 1.35 },
  shipyard: { hostType: 'station', base: { fuel: 0, metal: 50, gold: 30 }, costScaling: 1.7, baseTicks: 40, timeScaling: 1.3 },
  // Trajectory Control Thrusters — asteroid-weapon enabler. Mirrors
  // src/game/settlements.ts BUILDING_DEFS. hostBodyType restricts the
  // queueBuilding endpoint to rogue-asteroid bodies; without this an
  // unsanctioned POST could light Earth/Mars up with thrusters.
  //
  // hostType is 'station', NOT 'city', and the pair is load-bearing.
  // It was 'city' when cities could be founded anywhere. The
  // terraforming rework then gated cities on terraformed worlds and
  // made asteroids un-terraformable, so "a city on an asteroid" became
  // unsatisfiable and the whole ram weapon was stranded — built,
  // rendered, and impossible to reach. Zero thrusters and zero rams
  // exist across every game ever played, which is what that looks like
  // from the outside. A station is what a colony ship actually drops on
  // a rock, so this is the socket the weapon always meant.
  // THE TELESCOPE. Deliberately a CITY building and deliberately
  // multi-level: it is permanent infrastructure, not a one-shot survey
  // tool. Its real job is the sensor bubble -- fog of war gates transit
  // interception, so a telescope on a border world is early warning
  // against raiders as much as it is a rock-finder. That is what makes
  // it worth a Construction level rather than "finds a rock sometimes".
  // HOSTED ON THE STATION. Shields were briefly moved here and the
  // telescope put on the ground; that lasted about an hour, because
  // STATIONS ALREADY DIE BEFORE CITIES. Shields whose host dies first
  // are decoration -- the pool evaporates in the exchange that was
  // supposed to be the reason you bought it. Shields stay on the city.
  //
  // The telescope is the one that BELONGS in orbit: it is passive
  // infrastructure, so losing it first costs vision rather than a
  // defence, and a station's base sensor reach is 400 against a city's
  // 250 -- the bonus compounds on the better platform. It also keeps the
  // surface column at the four buttons COL_MAX_H budgets.
  telescope: {
    hostType: 'station',
    base: { fuel: 0, metal: 220, gold: 340 },
    costScaling: 1.6,
    baseTicks: 18,
    timeScaling: 1.25,
  },
  trajectory_thrusters: {
    hostType: 'station',
    hostBodyType: 'asteroid',
    base: { fuel: 0, metal: 800, gold: 1200 },
    costScaling: 99,   // single-level — impossibly expensive at L2
    baseTicks: 40,
    timeScaling: 1,
  },
};

function buildingCostAt(kind, level, mult = 1) {
  const def = BUILDING_DEFS[kind];
  if (!def) return null;
  const k = Math.pow(def.costScaling, level) * (mult > 0 ? mult : 1);
  return {
    metal: Math.ceil(def.base.metal * k),
    gold:  Math.ceil(def.base.gold  * k),
  };
}

/** building_cost_mult, or 1 if config is unreachable. Buildings are the
 *  economy's main sink, so this is the dial against ballooning treasuries. */
async function buildingCostMult(env, gameId) {
  try {
    const gc = await import('./gameConfig.js');
    const conf = await gc.cfg(env, gameId);
    const m = Number(conf.building_cost_mult);
    return Number.isFinite(m) && m > 0 ? m : 1;
  } catch { return 1; }
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
  // Every building is behind a level — lab/forge/mint on Society, the
  // shipyard and thrusters on Construction, station weapons and armor on
  // their combat tracks. BUILDING_FEATURE maps kind -> feature id.
  const buildingGate = await requireFeature(env, gameId, me.id, BUILDING_FEATURE[kind]);
  if (buildingGate) return buildingGate;

  const settlement = await env.DB
    .prepare(
      `SELECT id, owner_faction_id, type, buildings_json, building_order_json,
              building_backlog_json
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
  // A settlement already building something no longer refuses the order —
  // it lines it up behind. `active` is the in-flight upgrade (if any) and
  // `backlog` is everything waiting, in order.
  let active = null;
  if (settlement.building_order_json) {
    try { active = JSON.parse(settlement.building_order_json); } catch { active = null; }
  }
  let backlog = [];
  if (settlement.building_backlog_json) {
    try {
      const parsed = JSON.parse(settlement.building_backlog_json);
      if (Array.isArray(parsed)) backlog = parsed;
    } catch { backlog = []; }
  }
  // A ceiling so a misclick-happy player can't strand an unbounded pile of
  // resources in a queue they then have to unpick one at a time.
  if (active && backlog.length >= BUILD_BACKLOG_MAX) {
    return err(409, 'queue_full',
      `this settlement already has ${BUILD_BACKLOG_MAX} upgrades lined up — let one finish first`);
  }

  // Current level for this kind (default 0)
  let buildings = {};
  if (settlement.buildings_json) {
    try { buildings = JSON.parse(settlement.buildings_json) ?? {}; } catch { buildings = {}; }
  }
  // PROJECTED level, not the level on the ground. Anything of this kind
  // already in flight or queued ahead of us will have landed by the time
  // this one starts, so a second Forge must be priced and timed as L2 —
  // otherwise queueing three Forges buys three upgrades at the L1 price.
  const builtLevel = Number(buildings[kind] ?? 0);
  const aheadOfUs =
    (active && active.kind === kind ? 1 : 0)
    + backlog.filter(o => o && o.kind === kind).length;
  const currentLevel = builtLevel + aheadOfUs;
  const cost = buildingCostAt(kind, currentLevel, await buildingCostMult(env, gameId));
  const ticks = buildingTicksAt(kind, currentLevel);

  // NO POOL-ONLY AFFORDABILITY CHECK HERE.
  //
  // There used to be one, and it made the local-first spend below dead
  // code in the only case it exists for. A station on a raw world banks
  // 90% of its yield LOCALLY, and the whole point of that stockpile is
  // that the station can spend it on itself. But this check ran first and
  // 409'd on the faction pool alone — so a station sitting on 300 ore
  // could not start a 40-ore building while the pool was empty, and the
  // "drain the local stockpile before touching the pool" logic forty
  // lines down never got the chance to run.
  //
  // The real check is the LOCAL+pool one at the debit site, which is
  // where the numbers it validates are actually read.

  const game = await env.DB.prepare('SELECT current_tick FROM games WHERE id = ?').bind(gameId).first();
  const startTick = game?.current_tick ?? 0;
  const completeTick = startTick + ticks;

  const order = {
    id: `${settlementId}:b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    settlement_id: settlementId,
    kind,
    target_level: currentLevel + 1,
    // A BACKLOG entry has no schedule yet — it gets start/complete stamped
    // when it reaches the front (room.js §0.5). `ticks` rides along so the
    // duration is the one priced at queue time, not re-derived later
    // against a level that may have moved.
    ticks,
    start_tick: active ? null : startTick,
    complete_tick: active ? null : completeTick,
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
    // Spell out BOTH purses. This is now the only affordability message
    // a player can get here, and "need 40M 0G (LOCAL+pool)" doesn't say
    // which purse fell short — the whole reason a station build can be
    // affordable in one place and not another.
    // METAL and CREDITS — the names on the HUD. `ore` and `gold` survive
    // as internal keys (playerResources.ore, cost.gold, the prod-rate CSS
    // modifier) but were renamed in the fiction months ago, and a 409 is
    // no place to leak the old vocabulary at a player.
    return err(409, 'insufficient_resources',
      `${kind} L${currentLevel + 1} needs ${cost.metal} metal + ${cost.gold} credits. `
      + `This station has ${localMetal} metal + ${localGold} credits banked locally; `
      + `the empire pool has ${Math.max(0, me.metal)} metal + ${Math.max(0, me.gold)} credits.`);
  }
  const takeLocalMetal = Math.min(cost.metal, localMetal);
  const takeLocalGold  = Math.min(cost.gold,  localGold);
  const takePoolMetal  = cost.metal - takeLocalMetal;
  const takePoolGold   = cost.gold  - takeLocalGold;

  // CHARGE LEDGER, same idea as ships (migration 0084) but stored inside
  // the order blob since this one already is JSON. A building queued on a
  // raw world was drawn local-first and refunded wholly to the pool —
  // the identical laundering hole the ship queue had.
  const orderWithCharge = {
    ...order,
    charge: {
      local: { metal: takeLocalMetal, gold: takeLocalGold },
      pool: { metal: takePoolMetal, gold: takePoolGold },
    },
  };

  // CHARGE FIRST, guarded, then record the order — same fix and same reason
  // as the ship queue (see chargeConstruction). The 'busy' check above reads
  // a snapshot too, so without the guarded charge a double submit could pay
  // twice for one upgrade.
  const chargedB = await chargeConstruction(env, {
    factionId: me.id,
    drains: (takeLocalMetal > 0 || takeLocalGold > 0)
      ? [{ id: settlementId, metal: takeLocalMetal, gold: takeLocalGold }]
      : [],
    poolMetal: takePoolMetal,
    poolGold: takePoolGold,
  });
  if (!chargedB.ok) {
    return err(409, 'insufficient_resources',
      `Couldn't pay for ${kind} L${currentLevel + 1} — ${cost.metal} metal + ${cost.gold} credits. `
      + 'Your balance changed while the order was being placed. Nothing was taken.');
  }

  // Guarded write. Two shapes, same protection: whichever slot we believe
  // we're writing into must still look the way it did when we read it, so
  // two racing submits can't both land. A miss means the other one won:
  // refund this charge rather than silently eating it.
  //
  // Active slot free  -> stamp it (guard: still NULL).
  // Something building -> append to the backlog (guard: the backlog is
  //   byte-identical to what we read, so a concurrent append can't be
  //   clobbered by our stale copy).
  const stamp = active
    ? await env.DB
        .prepare(
          `UPDATE game_settlements SET building_backlog_json = ?
            WHERE id = ? AND building_order_json IS NOT NULL
              AND COALESCE(building_backlog_json, '[]') = ?`,
        )
        .bind(
          JSON.stringify([...backlog, orderWithCharge]),
          settlementId,
          settlement.building_backlog_json ?? '[]',
        )
        .run()
    : await env.DB
        .prepare(
          `UPDATE game_settlements SET building_order_json = ?
            WHERE id = ? AND building_order_json IS NULL`,
        )
        .bind(JSON.stringify(orderWithCharge), settlementId)
        .run();
  if (!stamp.meta?.changes) {
    if (takeLocalMetal > 0 || takeLocalGold > 0) {
      await env.DB
        .prepare(
          `UPDATE game_settlements
              SET stockpile_metal = stockpile_metal + ?,
                  stockpile_gold  = stockpile_gold  + ?
            WHERE id = ?`,
        )
        .bind(takeLocalMetal, takeLocalGold, settlementId).run();
    }
    if (takePoolMetal > 0 || takePoolGold > 0) {
      await env.DB
        .prepare('UPDATE game_factions SET metal = metal + ?, gold = gold + ? WHERE id = ?')
        .bind(takePoolMetal, takePoolGold, me.id).run();
    }
    return err(409, 'busy',
      "this settlement's build queue changed while the order was being placed — nothing was taken, try again");
  }

  await env.DB
    .prepare('INSERT INTO spend_events (game_id, faction_id, category, metal, gold, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(gameId, me.id, 'buildings', Math.round(cost.metal ?? 0), Math.round(cost.gold ?? 0), Date.now())
    .run();

  // queue_position: 0 = building now, 1 = next up, and so on. The client
  // paints this number on the button.
  return json({
    ok: true,
    order: orderWithCharge,
    cost,
    queue_position: active ? backlog.length + 1 : 0,
  });
}

async function handleCancelBuilding(req, env, ctx) {
  const { gameId, settlementId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const settlement = await env.DB
    .prepare(
      `SELECT id, owner_faction_id, building_order_json, buildings_json,
              building_backlog_json
         FROM game_settlements
        WHERE id = ? AND game_id = ? AND destroyed_at_tick IS NULL`,
    )
    .bind(settlementId, gameId)
    .first();
  if (!settlement) return err(404, 'not_found', 'settlement not found');
  if (settlement.owner_faction_id !== me.id) return err(403, 'not_owner', 'not your settlement');

  // ?order_id=... targets a QUEUED entry instead of the active build.
  // Without this a mis-queued upgrade would be unfixable: the resources
  // are charged at queue time, and the only other way out is to wait for
  // it to build. Refunds run off the same charge ledger (0084) as the
  // active path, so a raw world's local stockpile goes back to the
  // stockpile rather than laundering into the pool.
  const wantId = new URL(req.url).searchParams.get('order_id');
  if (wantId) {
    let backlog = [];
    if (settlement.building_backlog_json) {
      try {
        const parsed = JSON.parse(settlement.building_backlog_json);
        if (Array.isArray(parsed)) backlog = parsed;
      } catch { backlog = []; }
    }
    const idx = backlog.findIndex(o => o && o.id === wantId);
    if (idx < 0) return err(404, 'not_found', 'that upgrade is not in this queue');
    const dropped = backlog[idx];
    const remaining = backlog.filter((_, i) => i !== idx);
    // Guarded on the backlog being byte-identical to what we read, so two
    // concurrent cancels can't both refund the same entry.
    const flipQ = await env.DB
      .prepare(
        `UPDATE game_settlements SET building_backlog_json = ?
          WHERE id = ? AND COALESCE(building_backlog_json, '[]') = ?`,
      )
      .bind(
        remaining.length ? JSON.stringify(remaining) : null,
        settlementId,
        settlement.building_backlog_json ?? '[]',
      )
      .run();
    if (!flipQ.meta?.changes) return err(409, 'already_cancelled', 'that upgrade is no longer queued');

    const led = dropped.charge && typeof dropped.charge === 'object' ? dropped.charge : null;
    const locM = Number(led?.local?.metal ?? 0);
    const locG = Number(led?.local?.gold ?? 0);
    const poolM = Number(led?.pool?.metal ?? 0);
    const poolG = Number(led?.pool?.gold ?? 0);
    const stmts = [];
    if (locM > 0 || locG > 0) {
      stmts.push(env.DB
        .prepare(
          `UPDATE game_settlements
              SET stockpile_metal = stockpile_metal + ?,
                  stockpile_gold  = stockpile_gold  + ?
            WHERE id = ?`,
        )
        .bind(locM, locG, settlementId));
    }
    if (poolM > 0 || poolG > 0) {
      stmts.push(env.DB
        .prepare('UPDATE game_factions SET metal = metal + ?, gold = gold + ? WHERE id = ?')
        .bind(poolM, poolG, me.id));
    }
    if (stmts.length) await env.DB.batch(stmts);
    return json({
      ok: true,
      cancelled: { id: dropped.id, kind: dropped.kind },
      refund: { metal: locM + poolM, gold: locG + poolG },
    });
  }

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

  // Refund from the order's own CHARGE LEDGER (0084) when it has one.
  // Re-deriving the price and paying it all into the pool laundered a raw
  // world's local stockpile into spendable global credits, exactly as the
  // ship queue did, and additionally paid back at TODAY's building cost
  // multiplier rather than the one charged at queue time.
  const ledger = order.charge && typeof order.charge === 'object' ? order.charge : null;
  const legacyRefund = buildingCostAt(order.kind, Math.max(0, (order.target_level ?? 1) - 1),
    await buildingCostMult(env, gameId));
  // Guarded flip (building_order_json still set) + refund-only-if-changed
  // (see handleCancelBuild) so two concurrent cancels can't both refund.
  const flip = await env.DB
    .prepare('UPDATE game_settlements SET building_order_json = NULL WHERE id = ? AND building_order_json IS NOT NULL')
    .bind(settlementId)
    .run();
  if (!flip.meta?.changes) return err(409, 'already_cancelled', 'nothing to cancel');

  if (ledger) {
    const locM = Number(ledger.local?.metal ?? 0);
    const locG = Number(ledger.local?.gold ?? 0);
    const poolM = Number(ledger.pool?.metal ?? 0);
    const poolG = Number(ledger.pool?.gold ?? 0);
    const stmts = [];
    // The settlement is loaded and alive (the SELECT above required
    // destroyed_at_tick IS NULL), so its share always has a home here.
    if (locM > 0 || locG > 0) {
      stmts.push(env.DB
        .prepare(
          `UPDATE game_settlements
              SET stockpile_metal = stockpile_metal + ?,
                  stockpile_gold  = stockpile_gold  + ?
            WHERE id = ?`,
        )
        .bind(locM, locG, settlementId));
    }
    if (poolM > 0 || poolG > 0) {
      stmts.push(env.DB
        .prepare('UPDATE game_factions SET metal = metal + ?, gold = gold + ? WHERE id = ?')
        .bind(poolM, poolG, me.id));
    }
    if (stmts.length) await env.DB.batch(stmts);
    return json({
      ok: true,
      refund: {
        metal: locM + poolM, gold: locG + poolG,
        local: { metal: locM, gold: locG },
        pool: { metal: poolM, gold: poolG },
      },
    });
  }

  // Pre-0084 order: no ledger to honour, so keep the old approximation
  // rather than invent a different wrong number.
  await env.DB
    .prepare('UPDATE game_factions SET metal = metal + ?, gold = gold + ? WHERE id = ?')
    .bind(legacyRefund?.metal ?? 0, legacyRefund?.gold ?? 0, me.id)
    .run();
  return json({ ok: true, refund: { ...legacyRefund, legacy: true } });
}
// handleBuildCollector was deleted with the terraforming rework —
// collectors are dead as a concept (terraformed status IS the loading
// dock). The endpoint is GONE, not stubbed: a 404 tells a stale client
// the verb no longer exists, which is the truth.

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
//   - dest decides the route kind (terraform / logistics / dyson) —
//     see ROUTE TAXONOMY inside handleCreateTradeRoute
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
  // Can't put a delivery freighter on a standing route — one job per hull.
  const shipOnDelivery = await env.DB
    .prepare(`SELECT 1 AS x FROM trade_deliveries WHERE ship_id = ? AND resolved_at_tick IS NULL LIMIT 1`)
    .bind(shipId).first();
  if (shipOnDelivery) {
    return err(409, 'on_delivery', 'this freighter is hauling a trade shipment — wait for delivery');
  }

  // Origin must have a player-owned settlement.
  const origin = await env.DB
    .prepare('SELECT 1 AS x FROM game_settlements WHERE game_id = ? AND body_id = ? AND owner_faction_id = ? AND destroyed_at_tick IS NULL')
    .bind(gameId, originBodyId, me.id)
    .first();
  if (!origin) return err(409, 'no_origin_settlement', 'origin body has no player settlement to pick up from');

  // ROUTE TAXONOMY (terraforming rework). The destination decides what
  // kind of route this is, and each kind has its own legality rules:
  //
  //   dyson      dest = Sol.               Controller-only; origin must
  //                                        be a terraformed world.
  //   terraform  dest = a RAW world I own. Feeds the terraform meter;
  //                                        origin must be terraformed.
  //   logistics  dest = a terraformed      Classic stockpile hauling —
  //              world where I live.       raw frontier -> the grid.
  //
  // "Terraformed" replaced "has a collector" as the loading-dock rule
  // everywhere: terraformed worlds pay 100% of yield into the pool, so
  // they are the only places the pool is physically on the dock.
  let routeKind = 'logistics';
  const originTf = await env.DB
    .prepare(`SELECT b.terraformed_at_tick AS tf FROM game_bodies b WHERE b.id = ? AND b.game_id = ?`)
    .bind(originBodyId, gameId)
    .first();

  if (destBodyId === `${gameId}:sol`) {
    routeKind = 'dyson';
    const g = await env.DB
      .prepare('SELECT dyson_controller_faction_id FROM games WHERE id = ?')
      .bind(gameId)
      .first();
    if (g?.dyson_controller_faction_id !== me.id) {
      return err(409, 'not_controller', 'only the Dyson Sphere controller can run supply routes to Sol');
    }
    if (originTf?.tf == null) {
      return err(409, 'origin_not_terraformed', 'Dyson supply must load at one of your terraformed worlds');
    }
  } else {
    const destBody = await env.DB
      .prepare(
        `SELECT type, owner_faction_id, terraformed_at_tick,
                terraform_completes_at_tick, secret_kind, secret_revealed
           FROM game_bodies WHERE id = ? AND game_id = ? AND destroyed_at_tick IS NULL`,
      )
      .bind(destBodyId, gameId)
      .first();
    if (!destBody) return err(404, 'not_found', 'destination body not found');

    if (destBody.terraformed_at_tick == null) {
      // RAW destination => this is a TERRAFORM run.
      routeKind = 'terraform';
      if (destBody.owner_faction_id !== me.id) {
        return err(409, 'not_owner', 'you can only terraform a world you control — claim it with a station first');
      }
      if (!['terrestrial', 'moon', 'dwarf'].includes(destBody.type)) {
        return err(409, 'cannot_terraform', 'only terrestrial worlds, moons and dwarf planets can be terraformed');
      }
      // Discovery before terraforming (Lorne): a buried secret must be
      // dug up before the bulldozers roll. Bodies with no secret pass.
      if (destBody.secret_kind && !destBody.secret_revealed) {
        return err(409, 'unscouted', 'this world holds an undiscovered secret — scout it before terraforming');
      }
      if (originTf?.tf == null) {
        return err(409, 'origin_not_terraformed', 'terraform supply must load at one of your terraformed worlds');
      }
    } else {
      // Terraformed destination => classic LOGISTICS. The dest must be a
      // world where I actually live (contested bodies: settlement
      // presence is the gate, mirroring ship-build rules).
      const destMine = await env.DB
        .prepare('SELECT 1 AS x FROM game_settlements WHERE game_id = ? AND body_id = ? AND owner_faction_id = ? AND destroyed_at_tick IS NULL')
        .bind(gameId, destBodyId, me.id)
        .first();
      if (!destMine) return err(409, 'no_dest_settlement', 'destination is not one of your worlds');
    }
  }

  // Drop any prior active route for this ship (UI lets the player
  // replace; the UNIQUE INDEX would 409 otherwise).
  const game = await env.DB.prepare('SELECT current_tick FROM games WHERE id = ?').bind(gameId).first();
  const tick = game?.current_tick ?? 0;
  // TRADE V2: cancelling the replaced route must free its WHOLE crew —
  // guards and extra carriers included — or the one-job-per-hull index
  // pins live ships to a dead route forever.
  const replaced = (await env.DB
    .prepare('SELECT id FROM game_trade_routes WHERE ship_id = ? AND cancelled_at_tick IS NULL')
    .bind(shipId)
    .all()).results ?? [];
  await env.DB
    .prepare('UPDATE game_trade_routes SET cancelled_at_tick = ? WHERE ship_id = ? AND cancelled_at_tick IS NULL')
    .bind(tick, shipId)
    .run();
  for (const old of replaced) {
    await env.DB.prepare('DELETE FROM game_trade_route_ships WHERE route_id = ?').bind(old.id).run();
  }
  await env.DB.prepare('DELETE FROM game_trade_route_ships WHERE ship_id = ?').bind(shipId).run();

  // FOLD THE SHIP'S HOLD INTO THE NEW ROUTE. Cargo that outlived an
  // earlier route (cancel keeps it aboard — migration 0088) becomes this
  // route's opening load, so laying a new route IS how leftover freight
  // gets delivered: the machine sees cargo>0, heads for the destination,
  // and unloads there like any other run. Status starts 'outbound' in
  // that case — 'returning' would send a loaded freighter to the origin,
  // whose pickup branch wants an empty hold.
  const hold = await env.DB
    .prepare('SELECT cargo_fuel, cargo_metal, cargo_gold, cargo_science FROM game_ships WHERE id = ?')
    .bind(shipId)
    .first();
  const hFuel    = Number(hold?.cargo_fuel    ?? 0);
  const hMetal   = Number(hold?.cargo_metal   ?? 0);
  const hGold    = Number(hold?.cargo_gold    ?? 0);
  const hScience = Number(hold?.cargo_science ?? 0);
  const holdTotal = hFuel + hMetal + hGold + hScience;

  const routeId = `tr:${shipId}:${tick}:${Math.random().toString(36).slice(2, 6)}`;
  const stmts = [
    env.DB
      .prepare(
        `INSERT INTO game_trade_routes
           (id, game_id, owner_faction_id, ship_id,
            origin_body_id, dest_body_id, status, kind,
            cargo_fuel, cargo_metal, cargo_gold, cargo_science,
            created_at_tick)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(routeId, gameId, me.id, shipId, originBodyId, destBodyId,
            holdTotal > 0 ? 'outbound' : 'returning', routeKind,
            hFuel, hMetal, hGold, hScience, tick),
    // TRADE V2: the two-stop itinerary + the crew row. The old create
    // IS the fast path now — it just writes a two-stop route under the
    // hood, which is what lets the same route grow stops later.
    // Cursor mirrors status: loaded hold -> heading for stop 1.
    env.DB
      .prepare(
        `INSERT INTO game_trade_route_stops
           (id, game_id, route_id, sequence, body_id, action)
         VALUES (?, ?, ?, 0, ?, 'pickup')`,
      )
      .bind(routeId + ':s0', gameId, routeId, originBodyId),
    env.DB
      .prepare(
        `INSERT INTO game_trade_route_stops
           (id, game_id, route_id, sequence, body_id, action)
         VALUES (?, ?, ?, 1, ?, 'dropoff')`,
      )
      .bind(routeId + ':s1', gameId, routeId, destBodyId),
    env.DB
      .prepare(
        `INSERT INTO game_trade_route_ships
           (id, game_id, route_id, ship_id, role, next_stop_seq,
            cargo_fuel, cargo_metal, cargo_gold, cargo_science, added_at_tick)
         VALUES (?, ?, ?, ?, 'carrier', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(routeId + ':c0', gameId, routeId, shipId,
            holdTotal > 0 ? 1 : 0, hFuel, hMetal, hGold, hScience, tick),
  ];
  if (holdTotal > 0) {
    stmts.push(env.DB
      .prepare('UPDATE game_ships SET cargo_fuel = 0, cargo_metal = 0, cargo_gold = 0, cargo_science = 0 WHERE id = ?')
      .bind(shipId));
  }
  await env.DB.batch(stmts);

  // Dispatch NOW rather than at the next tick. The route pass is what
  // moves freighters, so a route laid just after a tick left the ship
  // parked for a full tick — an hour of real time on a default game —
  // with no indication anything was queued. Players read that as the
  // route being broken, especially when the freighter happened to be
  // sitting at the destination already.
  //
  // Best-effort: the DO swallows its own errors and the tick pass still
  // picks the route up, so a failure here costs responsiveness, never
  // the route itself.
  let dispatched = false;
  try {
    const res = await env.ROOM.get(env.ROOM.idFromName(gameId))
      .fetch('https://room/dispatch-route', {
        method: 'POST',
        body: JSON.stringify({ gameId, routeId }),
      });
    dispatched = res.ok;
  } catch (e) {
    console.error('route created but immediate dispatch failed', e, { routeId });
  }

  return json({ ok: true, dispatched, route: { id: routeId, ship_id: shipId, origin_body_id: originBodyId, dest_body_id: destBodyId, kind: routeKind } });
}


/**
 * POST /api/games/:gameId/ships/:shipId/mine — start or stop working the
 * rock this freighter is parked on.
 *
 * THE MANUAL HALF OF MINING. A trade route is the right tool for a
 * standing operation and the wrong one for "this hull is already sitting
 * on the rock, dig". The route path is untouched; this runs beside it.
 *
 * Deliberately NOT a one-shot "mine 400 units" call: extraction happens
 * in the tick, at the same MINE_RATE_PER_TICK the routed path uses, so
 * both flows cost the same dwell and carry the same risk. A button that
 * filled the hold instantly would make the manual path strictly better
 * than the automated one and quietly delete the tradeoff.
 *
 * Refusals get their own codes so the button can say why:
 *   no_rig       - the hull carries no Mining Rig
 *   in_transit   - mid-burn; you cannot dig from a moving ship
 *   not_a_rock   - parked somewhere that is not a meteoroid
 *   exhausted    - the rock is worked out
 *   undiscovered - not surveyed by you (you cannot work what you have
 *                  not found; mirrors the route-stop gate)
 *   on_a_route   - the autopilot already owns this hull, and two things
 *                  steering one freighter is how a ship ends up parked
 *                  forever
 *   hold_full    - nowhere to put it
 */
/**
 * POST /api/games/:gameId/ships/:shipId/place-framework
 *
 * Spend a colony ship laying the foundation for a megastructure at an
 * arbitrary point, which then adopts an orbit from whatever sphere of
 * influence it landed in.
 *
 * THE SHIP MUST ALREADY BE IN THE NEIGHBOURHOOD. The point has to fall
 * inside the SOI of the body the ship is parked at. Movement in this
 * game is a flight plan of nodes, and inventing a second kind of
 * transit whose destination does not exist yet would be a much larger
 * change than the feature is worth: the player flies the colony ship
 * out with the tools that already work, then places. What they cannot
 * do is place a foundation across the system from the hull paying for
 * it.
 *
 * The hull is consumed. That is the same bargain as founding a
 * settlement, and it is what makes placement a commitment somebody can
 * see coming rather than a free marker.
 */
async function handlePlaceFramework(req, env, ctx) {
  const { gameId, shipId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  let payload = {};
  try { payload = await req.json(); } catch { payload = {}; }
  const kind = String(payload?.kind ?? '');
  const spec = MEGASTRUCTURES[kind];
  if (!spec) return err(400, 'bad_kind', 'no such megastructure');

  const x = Number(payload?.x);
  const y = Number(payload?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return err(400, 'bad_point', 'placement needs a finite x and y');
  }

  // Two gates: the module that lets you build ANYTHING, and the research
  // for this particular structure. Checked separately so the rejection
  // names the one actually missing.
  const gate1 = await requireFeature(env, gameId, me.id, 'part.construction');
  if (gate1) return gate1;
  const gate2 = await requireFeature(env, gameId, me.id, spec.feature);
  if (gate2) return gate2;

  const ship = await env.DB
    .prepare(
      `SELECT id, owner_faction_id, status, parent_body_id, parts_json, ship_class
         FROM game_ships WHERE id = ? AND game_id = ?`,
    )
    .bind(shipId, gameId).first();
  if (!ship || ship.owner_faction_id !== me.id) return err(404, 'not_found', 'ship not found');
  if (ship.status !== 'active') return err(409, 'not_active', 'ship is not active');
  if (ship.ship_class !== 'colony') {
    return err(409, 'wrong_hull', 'only a colony ship can lay a foundation');
  }

  const parts = parsePartsJson(ship.ship_class, ship.parts_json);
  if (!parts.includes('construction')) {
    return err(409, 'no_module', 'this colony ship has no Construction Module');
  }

  const flying = await env.DB
    .prepare(`SELECT 1 AS x FROM game_ship_nodes
               WHERE ship_id = ? AND status = 'in_transit' LIMIT 1`)
    .bind(shipId).first();
  if (flying) return err(409, 'in_transit', 'mid-burn — arrive first');

  const game = await env.DB
    .prepare('SELECT current_tick FROM games WHERE id = ?')
    .bind(gameId).first();
  const tick = Number(game?.current_tick ?? 0);

  const bodies = (await env.DB
    .prepare(
      `SELECT id, name, type, parent_body_id, mu, soi, orbit_radius, orbit_period, angle0
         FROM game_bodies WHERE game_id = ? AND destroyed_at_tick IS NULL`,
    )
    .bind(gameId).all()).results ?? [];

  const orbit = deriveSiteOrbit({ x, y }, bodies, tick);
  if (!orbit) return err(409, 'nowhere', 'that point is not in any system');

  // The neighbourhood rule. soiHolderAt already picked the innermost
  // owner of the point; the ship has to be parked on it.
  const holder = soiHolderAt({ x, y }, bodies, tick);
  if (!holder || holder.id !== ship.parent_body_id) {
    // NAME BOTH BODIES. "Too far" on its own leaves a player guessing
    // whether they misjudged the distance or the rule; saying which
    // system the point fell in, and which one the ship is parked at,
    // turns it into an instruction.
    const parked = bodies.find(b => b.id === ship.parent_body_id);
    const parkedName = parked?.name ?? 'its current body';
    const holderName = holder?.name ?? 'open space';
    return err(409, 'too_far',
      `That point is in ${holderName}'s space, but the ship is parked at `
      + `${parkedName}. Fly it there first, or pick a point inside `
      + `${parkedName}'s sphere of influence.`);
  }

  const siteId = `${gameId}:mega_${crypto.randomUUID().slice(0, 8)}`;
  const name = `${spec.label} Site`;

  await env.DB.batch([
    // The site IS a body. Everything downstream — position, rendering,
    // sensors, route destinations — already handles bodies.
    env.DB.prepare(
      `INSERT INTO game_bodies
         (id, game_id, template_id, name, type, parent_body_id, radius, soi, mu,
          orbit_radius, orbit_period, angle0, color, owner_faction_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)`,
    ).bind(
      siteId, gameId, `mega_${kind}`, name, MEGA_BODY_TYPE,
      orbit.parent_body_id, spec.radius,
      orbit.orbit_radius, orbit.orbit_period, orbit.angle0,
      spec.color, me.id,
    ),
    env.DB.prepare(
      `INSERT INTO game_megastructures
         (body_id, game_id, kind, status, cost_metal, cost_credits,
          founded_by_faction_id, founded_at_tick)
       VALUES (?, ?, ?, 'building', ?, ?, ?, ?)`,
    ).bind(siteId, gameId, kind, spec.cost.metal, spec.cost.credits, me.id, tick),
    // The hull is spent. Marked destroyed rather than deleted so the
    // fleet history and any battle records that name it still resolve.
    env.DB.prepare(
      `UPDATE game_ships SET status = 'destroyed', destroyed_at_tick = ? WHERE id = ?`,
    ).bind(tick, shipId),
    // The founder can always see their own foundation, whatever their
    // sensors say about that patch of sky.
    env.DB.prepare(
      `INSERT OR IGNORE INTO game_body_discoveries (game_id, faction_id, body_id, discovered_at_tick)
       VALUES (?, ?, ?, ?)`,
    ).bind(gameId, me.id, siteId, tick),
  ]);

  return json({
    ok: true,
    site: {
      id: siteId,
      kind,
      name,
      parent_body_id: orbit.parent_body_id,
      orbit_radius: orbit.orbit_radius,
      cost: { metal: spec.cost.metal, credits: spec.cost.credits },
    },
  });
}

/**
 * POST /api/games/:gameId/megastructures/:siteId/deliver
 *
 * Hand a parked ship's cargo to a construction site. The manual half of
 * the loop — trade routes are the automated half, and both bank into the
 * same two accumulators.
 *
 * A SITE TAKES ONLY WHAT IT STILL NEEDS. Overpaying a nearly-finished
 * structure would swallow a full hold to buy the last fifty metal, and
 * the cargo that was not needed stays aboard rather than evaporating —
 * the same rule the terraform route follows when its job disappears.
 *
 * Anyone may deliver, including to a site they do not own. That falls
 * out of the design rather than being designed: a captured site keeps
 * the progress its previous owner paid for, so "cargo you put in is not
 * necessarily cargo you get to keep" is already true, and forbidding
 * gift deliveries would only stop allies from co-funding a gate.
 */
async function handleDeliverToSite(req, env, ctx) {
  const { gameId, siteId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  let payload = {};
  try { payload = await req.json(); } catch { payload = {}; }
  const shipId = String(payload?.ship_id ?? '');
  if (!shipId) return err(400, 'bad_request', 'ship_id required');

  const site = await env.DB
    .prepare(
      `SELECT m.body_id, m.kind, m.status, m.acc_metal, m.acc_credits,
              m.cost_metal, m.cost_credits, b.name
         FROM game_megastructures m
         JOIN game_bodies b ON b.id = m.body_id
        WHERE m.body_id = ? AND m.game_id = ? AND b.destroyed_at_tick IS NULL`,
    )
    .bind(siteId, gameId).first();
  if (!site) return err(404, 'not_found', 'no such construction site');
  if (site.status === 'complete') {
    return err(409, 'already_done', `${site.name} is finished`);
  }

  const ship = await env.DB
    .prepare(
      `SELECT id, owner_faction_id, status, parent_body_id,
              cargo_metal, cargo_gold
         FROM game_ships WHERE id = ? AND game_id = ?`,
    )
    .bind(shipId, gameId).first();
  if (!ship || ship.owner_faction_id !== me.id) return err(404, 'not_found', 'ship not found');
  if (ship.status !== 'active') return err(409, 'not_active', 'ship is not active');
  if (ship.parent_body_id !== siteId) {
    return err(409, 'not_here', 'the ship has to be parked at the site to unload into it');
  }

  const want = remainingFor(site);
  const giveMetal = Math.min(Number(ship.cargo_metal) || 0, want.metal);
  const giveCredits = Math.min(Number(ship.cargo_gold) || 0, want.credits);
  if (giveMetal <= 0 && giveCredits <= 0) {
    return err(409, 'nothing_to_give',
      want.metal <= 0 && want.credits <= 0
        ? 'this site has everything it needs'
        : 'this ship carries nothing the site still wants');
  }

  const nextAcc = {
    acc_metal: (Number(site.acc_metal) || 0) + giveMetal,
    acc_credits: (Number(site.acc_credits) || 0) + giveCredits,
  };
  const done = isComplete({ ...site, ...nextAcc });

  const game = await env.DB
    .prepare('SELECT current_tick FROM games WHERE id = ?')
    .bind(gameId).first();
  const tick = Number(game?.current_tick ?? 0);

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE game_megastructures
          SET acc_metal = ?, acc_credits = ?,
              status = ?, completed_at_tick = ?
        WHERE body_id = ?`,
    ).bind(
      nextAcc.acc_metal, nextAcc.acc_credits,
      done ? 'complete' : 'building',
      done ? tick : null,
      siteId,
    ),
    env.DB.prepare(
      `UPDATE game_ships
          SET cargo_metal = cargo_metal - ?, cargo_gold = cargo_gold - ?
        WHERE id = ?`,
    ).bind(giveMetal, giveCredits, shipId),
  ]);

  return json({
    ok: true,
    delivered: { metal: giveMetal, credits: giveCredits },
    site: {
      id: siteId,
      status: done ? 'complete' : 'building',
      progress: progressOf({ ...site, ...nextAcc }),
      remaining: remainingFor({ ...site, ...nextAcc }),
    },
  });
}

/**
 * POST /api/games/:gameId/megastructures/:siteId/pair
 * body: { partner_body_id: string | null }
 *
 * Wire one of your finished gates to another, or cut the link.
 *
 * EXACTLY ONE PARTNER, BOTH WAYS. The cardinality is the design — a gate
 * network is a topology you plan rather than a teleport-anywhere button —
 * so pairing A to B silently drops whatever A and B were previously
 * wired to. Doing it any other way would let a player build a hub by
 * accident and then wonder why the rules said they could not.
 *
 * You may only wire gates YOU own. Anyone may fly through them
 * afterwards, which is the whole risk of building one.
 */
async function handlePairGate(req, env, ctx) {
  const { gameId, siteId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  let payload = {};
  try { payload = await req.json(); } catch { payload = {}; }
  const partnerId = payload?.partner_body_id ? String(payload.partner_body_id) : null;

  /** A finished warp gate this faction owns. */
  const loadGate = async (id) => env.DB
    .prepare(
      `SELECT m.body_id, m.kind, m.status, m.partner_body_id, b.name, b.owner_faction_id
         FROM game_megastructures m
         JOIN game_bodies b ON b.id = m.body_id
        WHERE m.body_id = ? AND m.game_id = ? AND b.destroyed_at_tick IS NULL`,
    )
    .bind(id, gameId).first();

  const gate = await loadGate(siteId);
  if (!gate) return err(404, 'not_found', 'no such structure');
  if (gate.kind !== 'warp_gate') return err(409, 'not_a_gate', `${gate.name} is not a warp gate`);
  if (gate.owner_faction_id !== me.id) return err(403, 'not_yours', 'you do not own that gate');
  if (gate.status !== 'complete') {
    return err(409, 'unfinished', `${gate.name} is still under construction`);
  }

  // ---- unlink ----
  if (!partnerId) {
    const stmts = [
      env.DB.prepare('UPDATE game_megastructures SET partner_body_id = NULL WHERE body_id = ?')
        .bind(siteId),
    ];
    // Clear the far end too. A one-sided link is a gate that swallows
    // ships and cannot send them back.
    if (gate.partner_body_id) {
      stmts.push(
        env.DB.prepare('UPDATE game_megastructures SET partner_body_id = NULL WHERE body_id = ?')
          .bind(gate.partner_body_id),
      );
    }
    await env.DB.batch(stmts);
    return json({ ok: true, partner: null });
  }

  if (partnerId === siteId) return err(409, 'self_link', 'a gate cannot pair with itself');

  const partner = await loadGate(partnerId);
  if (!partner) return err(404, 'not_found', 'no such partner gate');
  if (partner.kind !== 'warp_gate') {
    return err(409, 'not_a_gate', `${partner.name} is not a warp gate`);
  }
  if (partner.owner_faction_id !== me.id) {
    return err(403, 'not_yours', `you do not own ${partner.name}`);
  }
  if (partner.status !== 'complete') {
    return err(409, 'unfinished', `${partner.name} is still under construction`);
  }

  // Drop both gates' old links before making the new one, so no third
  // gate is left pointing at something that no longer points back.
  const orphans = [gate.partner_body_id, partner.partner_body_id]
    .filter(id => id && id !== siteId && id !== partnerId);

  await env.DB.batch([
    ...orphans.map(id => env.DB
      .prepare('UPDATE game_megastructures SET partner_body_id = NULL WHERE body_id = ?')
      .bind(id)),
    env.DB.prepare('UPDATE game_megastructures SET partner_body_id = ? WHERE body_id = ?')
      .bind(partnerId, siteId),
    env.DB.prepare('UPDATE game_megastructures SET partner_body_id = ? WHERE body_id = ?')
      .bind(siteId, partnerId),
  ]);

  return json({ ok: true, partner: { id: partnerId, name: partner.name }, unlinked: orphans });
}

/**
 * POST /api/games/:gameId/ships/:shipId/gate
 *
 * Step a parked ship through the gate it is sitting on, to the far end.
 *
 * ANYONE MAY USE ANY GATE, including one built by the faction they are
 * invading. That is deliberate and it is the whole risk of owning one:
 * a gate is a two-way door, so nobody sensibly links one to their
 * capital. The counter is to cut the link, not to lock the door.
 *
 * Transit is INSTANT, matching the portal secret this is built on — a
 * gate that took ticks would need a second kind of transit with a
 * destination that moves, and the point of the structure is that it
 * defeats distance.
 */
async function handleGateTransit(req, env, ctx) {
  const { gameId, shipId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const ship = await env.DB
    .prepare(
      `SELECT id, name, owner_faction_id, status, parent_body_id, ship_class
         FROM game_ships WHERE id = ? AND game_id = ?`,
    )
    .bind(shipId, gameId).first();
  if (!ship || ship.owner_faction_id !== me.id) return err(404, 'not_found', 'ship not found');
  if (ship.status !== 'active') return err(409, 'not_active', 'ship is not active');

  // The Death Star does not fit. Its whole design is that it has to
  // cross real distance, telegraphing itself for days; a gate would
  // undo that in one click.
  if (ship.ship_class === 'mega_destroyer') {
    return err(409, 'too_big', 'a Mega Destroyer does not fit through a gate');
  }

  const flying = await env.DB
    .prepare(`SELECT 1 AS x FROM game_ship_nodes
               WHERE ship_id = ? AND status = 'in_transit' LIMIT 1`)
    .bind(shipId).first();
  if (flying) return err(409, 'in_transit', 'mid-burn — arrive at the gate first');

  const gate = await env.DB
    .prepare(
      `SELECT m.body_id, m.kind, m.status, m.partner_body_id, b.name
         FROM game_megastructures m
         JOIN game_bodies b ON b.id = m.body_id
        WHERE m.body_id = ? AND m.game_id = ? AND b.destroyed_at_tick IS NULL`,
    )
    .bind(ship.parent_body_id, gameId).first();
  if (!gate || gate.kind !== 'warp_gate') {
    return err(409, 'no_gate', 'park the ship on a warp gate first');
  }
  if (gate.status !== 'complete') {
    return err(409, 'unfinished', `${gate.name} is still under construction`);
  }
  if (!gate.partner_body_id) {
    return err(409, 'unpaired', `${gate.name} is not wired to anything`);
  }

  const far = await env.DB
    .prepare(
      `SELECT b.id, b.name FROM game_bodies b
         JOIN game_megastructures m ON m.body_id = b.id
        WHERE b.id = ? AND b.destroyed_at_tick IS NULL AND m.status = 'complete'`,
    )
    .bind(gate.partner_body_id).first();
  if (!far) {
    return err(409, 'partner_gone', `the far end of ${gate.name} is no longer there`);
  }

  const game = await env.DB
    .prepare('SELECT current_tick FROM games WHERE id = ?')
    .bind(gameId).first();
  const tick = Number(game?.current_tick ?? 0);

  await env.DB.batch([
    env.DB.prepare('UPDATE game_ships SET parent_body_id = ? WHERE id = ?')
      .bind(far.id, shipId),
    // Arriving somewhere new reveals it. Without this a ship can step
    // through to a gate it has never surveyed and sit on a body its own
    // owner cannot see.
    env.DB.prepare(
      `INSERT OR IGNORE INTO game_body_discoveries (game_id, faction_id, body_id, discovered_at_tick)
       VALUES (?, ?, ?, ?)`,
    ).bind(gameId, me.id, far.id, tick),
  ]);

  return json({ ok: true, from: { id: gate.body_id, name: gate.name }, to: { id: far.id, name: far.name } });
}

async function handleSetMining(req, env, ctx) {
  const { gameId, shipId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  const active = body?.active !== false;      // default: start

  const ship = await env.DB
    .prepare(
      `SELECT id, owner_faction_id, status, parent_body_id, parts_json, ship_class,
              captain_id, cargo_fuel, cargo_metal, cargo_gold, cargo_science
         FROM game_ships WHERE id = ? AND game_id = ?`,
    )
    .bind(shipId, gameId).first();
  if (!ship || ship.owner_faction_id !== me.id) return err(404, 'not_found', 'ship not found');
  if (ship.status !== 'active') return err(409, 'not_active', 'ship is not active');

  // STOPPING is always allowed — an order you cannot rescind is a trap.
  if (!active) {
    await env.DB.prepare('UPDATE game_ships SET mining_body_id = NULL WHERE id = ?')
      .bind(shipId).run();
    return json({ ok: true, mining: null });
  }

  // TWO ARGUMENTS. parsePartsJson validates the loadout against the
  // HULL, so calling it with one passes the JSON string as the ship
  // class, which is not a class, so validation fails and every rigged
  // freighter reported no_rig. The rig was fitted; the check was asking
  // the wrong question.
  const parts = parsePartsJson(ship.ship_class, ship.parts_json);
  if (!parts.includes('mining')) {
    return err(409, 'no_rig', 'this freighter has no Mining Rig');
  }

  const flying = await env.DB
    .prepare(`SELECT 1 AS x FROM game_ship_nodes
               WHERE ship_id = ? AND status = 'in_transit' LIMIT 1`)
    .bind(shipId).first();
  if (flying) return err(409, 'in_transit', 'mid-burn — park on the rock first');

  const routed = await env.DB
    .prepare('SELECT 1 AS x FROM game_trade_route_ships WHERE ship_id = ? LIMIT 1')
    .bind(shipId).first();
  if (routed) {
    return err(409, 'on_a_route',
      'this freighter is flying a trade route — take it off the route to work a rock by hand');
  }

  const rock = await env.DB
    .prepare(
      `SELECT id, name, mineral_kind, mineral_remaining
         FROM game_bodies WHERE id = ? AND game_id = ? AND destroyed_at_tick IS NULL`,
    )
    .bind(ship.parent_body_id, gameId).first();
  if (!rock || !rock.mineral_kind) return err(409, 'not_a_rock', 'nothing to mine here');
  if (Number(rock.mineral_remaining ?? 0) <= 0) {
    return err(409, 'exhausted', `${rock.name} is worked out`);
  }

  const seen = await env.DB
    .prepare('SELECT 1 AS x FROM game_body_discoveries WHERE game_id = ? AND faction_id = ? AND body_id = ?')
    .bind(gameId, me.id, rock.id).first();
  if (!seen) return err(409, 'undiscovered', 'your fleet has not surveyed this rock');

  const cap = holdCapFor(await captainTraitsOf(env, ship.captain_id));
  const carried = Number(ship.cargo_fuel ?? 0) + Number(ship.cargo_metal ?? 0)
    + Number(ship.cargo_gold ?? 0) + Number(ship.cargo_science ?? 0);
  if (carried >= cap) return err(409, 'hold_full', 'the hold is full — unload before mining');

  await env.DB.prepare('UPDATE game_ships SET mining_body_id = ? WHERE id = ?')
    .bind(rock.id, shipId).run();
  return json({ ok: true, mining: rock.id, hold_cap: cap, carried });
}

/** Captain traits for a hold-cap lookup, or null when uncrewed. */
async function captainTraitsOf(env, captainId) {
  if (!captainId) return null;
  const row = await env.DB
    .prepare('SELECT traits_json FROM game_captains WHERE id = ?')
    .bind(captainId).first();
  return row?.traits_json ?? null;
}

/**
 * POST /api/games/:gameId/ships/:shipId/unload-hold — dump a routed
 * freighter's cargo into the faction pool, without touching the route.
 *
 * The only place cargo persists is a trade route's cargo_* columns, and
 * until now the only way to get at it early was CANCEL, which refunds
 * the hold but kills the whole route — redirect a hauler once and you
 * rebuild its route from scratch. Unload is the missing half: take the
 * goods now, keep the standing orders. The route machine already
 * handles an empty-hold freighter anywhere on the map ("nudge toward
 * where the cargo says to go" — it heads to origin and picks up again),
 * so zeroing cargo mid-leg leaves a well-defined route, not a wedge.
 *
 * Pool, not local stockpile: every existing early-exit path for route
 * cargo (cancel refund, rival-dyson dump-home) pays the pool, and the
 * pool is where spendable resources live.
 *
 * Refusals, each with its own code so the button can say why:
 *   - contracted:   agreement legs haul goods OWED to the counterparty;
 *                   pocketing them would be theft-by-button. Cancelling
 *                   the agreement is the honest exit and refunds via the
 *                   cancel path.
 *   - in_transit:   no handing cargo off mid-burn.
 *   - empty_hold:   nothing aboard.
 */
async function handleUnloadHold(req, env, ctx) {
  const { gameId, shipId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const ship = await env.DB
    .prepare(`SELECT id, ship_class, status, owner_faction_id FROM game_ships
               WHERE id = ? AND game_id = ?`)
    .bind(shipId, gameId)
    .first();
  if (!ship || ship.owner_faction_id !== me.id) return err(404, 'not_found', 'ship not found');
  if (ship.status !== 'active') return err(409, 'not_active', 'ship is not active');

  const flying = await env.DB
    .prepare(`SELECT 1 AS x FROM game_ship_nodes
               WHERE ship_id = ? AND status = 'in_transit' LIMIT 1`)
    .bind(shipId)
    .first();
  if (flying) return err(409, 'in_transit', 'the freighter is mid-burn — cargo transfers only in orbit');

  // The physical hold is TWO pots: the ship's own cargo columns (loads
  // that outlived a route — migration 0088) and the active route's
  // per-leg staging. Unload empties both, EXCEPT cargo on an agreement
  // leg — that load is owed to the counterparty, and pocketing it would
  // be theft-by-button. Ship-level cargo is always the player's own.
  const shipCargo = await env.DB
    .prepare('SELECT cargo_fuel, cargo_metal, cargo_gold, cargo_science FROM game_ships WHERE id = ?')
    .bind(shipId)
    .first();
  let fuel    = Number(shipCargo?.cargo_fuel    ?? 0);
  let metal   = Number(shipCargo?.cargo_metal   ?? 0);
  let gold    = Number(shipCargo?.cargo_gold    ?? 0);
  let science = Number(shipCargo?.cargo_science ?? 0);

  // TRADE V2: a hull's route staging may live on its CREW ROW (walker
  // kinds) rather than the route columns — and a hull can be a
  // non-primary carrier, whose route lookup by ship_id finds nothing.
  // The crew row is the authority wherever it exists.
  const crewRow = await env.DB
    .prepare(
      `SELECT c.id, c.role, c.cargo_fuel, c.cargo_metal, c.cargo_gold, c.cargo_science,
              r.id AS route_id, r.kind, r.counterparty_faction_id, r.consolidated
         FROM game_trade_route_ships c
         JOIN game_trade_routes r ON r.id = c.route_id
        WHERE c.ship_id = ? AND r.cancelled_at_tick IS NULL`,
    )
    .bind(shipId)
    .first();
  const route = await env.DB
    .prepare(
      `SELECT id, counterparty_faction_id,
              cargo_fuel, cargo_metal, cargo_gold, cargo_science
         FROM game_trade_routes
        WHERE ship_id = ? AND game_id = ? AND cancelled_at_tick IS NULL`,
    )
    .bind(shipId, gameId)
    .first();
  const crewWalker = crewRow && crewRow.kind === 'logistics'
    && !crewRow.consolidated && !crewRow.counterparty_faction_id
    && crewRow.role === 'carrier';
  const routeOwn = !crewRow && route && !route.counterparty_faction_id;
  const rFuel    = routeOwn ? Number(route.cargo_fuel    ?? 0) : 0;
  const rMetal   = routeOwn ? Number(route.cargo_metal   ?? 0) : 0;
  const rGold    = routeOwn ? Number(route.cargo_gold    ?? 0) : 0;
  const rScience = routeOwn ? Number(route.cargo_science ?? 0) : 0;

  const kFuel    = crewWalker ? Number(crewRow.cargo_fuel    ?? 0) : 0;
  const kMetal   = crewWalker ? Number(crewRow.cargo_metal   ?? 0) : 0;
  const kGold    = crewWalker ? Number(crewRow.cargo_gold    ?? 0) : 0;
  const kScience = crewWalker ? Number(crewRow.cargo_science ?? 0) : 0;
  if (fuel + metal + gold + science + rFuel + rMetal + rGold + rScience
      + kFuel + kMetal + kGold + kScience < 1) {
    // Distinguish "empty" from "full but not yours to take" so the
    // button can say why.
    const contracted = route && route.counterparty_faction_id
      && Number(route.cargo_fuel ?? 0) + Number(route.cargo_metal ?? 0)
       + Number(route.cargo_gold ?? 0) + Number(route.cargo_science ?? 0) >= 1;
    if (contracted) {
      return err(409, 'contracted',
        'everything aboard is owed to your trade partner — cancel the agreement to reclaim it');
    }
    return err(409, 'empty_hold', 'the hold is empty');
  }

  // Guarded zeroes + credit-only-if-changed (handleCancelTradeRoute's
  // pattern): the cargo columns in each WHERE pin the exact load we
  // read, so a racing unload/pickup/delivery turns this into a no-op
  // instead of double-banking.
  if (fuel + metal + gold + science > 0) {
    const flip = await env.DB
      .prepare(
        `UPDATE game_ships
            SET cargo_fuel = 0, cargo_metal = 0, cargo_gold = 0, cargo_science = 0
          WHERE id = ?
            AND cargo_fuel = ? AND cargo_metal = ? AND cargo_gold = ? AND cargo_science = ?`,
      )
      .bind(shipId, fuel, metal, gold, science)
      .run();
    if (!flip.meta?.changes) { fuel = 0; metal = 0; gold = 0; science = 0; }
  }
  if (rFuel + rMetal + rGold + rScience > 0) {
    const flip = await env.DB
      .prepare(
        `UPDATE game_trade_routes
            SET cargo_fuel = 0, cargo_metal = 0, cargo_gold = 0, cargo_science = 0
          WHERE id = ? AND cancelled_at_tick IS NULL
            AND cargo_fuel = ? AND cargo_metal = ? AND cargo_gold = ? AND cargo_science = ?`,
      )
      .bind(route.id, rFuel, rMetal, rGold, rScience)
      .run();
    if (flip.meta?.changes) { fuel += rFuel; metal += rMetal; gold += rGold; science += rScience; }
  }
  if (crewWalker) {
    const kf = Number(crewRow.cargo_fuel ?? 0), km = Number(crewRow.cargo_metal ?? 0);
    const kg = Number(crewRow.cargo_gold ?? 0), ks = Number(crewRow.cargo_science ?? 0);
    if (kf + km + kg + ks > 0) {
      const flip = await env.DB
        .prepare(
          `UPDATE game_trade_route_ships
              SET cargo_fuel = 0, cargo_metal = 0, cargo_gold = 0, cargo_science = 0
            WHERE id = ?
              AND cargo_fuel = ? AND cargo_metal = ? AND cargo_gold = ? AND cargo_science = ?`,
        )
        .bind(crewRow.id, kf, km, kg, ks)
        .run();
      if (flip.meta?.changes) {
        fuel += kf; metal += km; gold += kg; science += ks;
        // Keep the primary's mirror honest — stale clients read it.
        await env.DB
          .prepare(`UPDATE game_trade_routes SET cargo_fuel = 0, cargo_metal = 0, cargo_gold = 0, cargo_science = 0 WHERE id = ? AND ship_id = ?`)
          .bind(crewRow.route_id, shipId)
          .run();
      }
    }
  }
  if (fuel + metal + gold + science < 1) {
    return err(409, 'conflict', 'the hold changed underneath you — try again');
  }

  // LEGACY FUEL IS DISCARDED, NOT BANKED. A hold that predates the
  // purge can still be carrying some; zeroing the hold above cleans the
  // ship, and crediting the pool here would put a resource back into an
  // empire that cannot spend it, see it, or trade it. Unloading is
  // therefore the last way fuel leaves the game, not a way it returns.
  await env.DB
    .prepare('UPDATE game_factions SET metal = metal + ?, gold = gold + ?, science = science + ? WHERE id = ?')
    .bind(metal, gold, science, me.id)
    .run();

  return json({ ok: true, unloaded: { metal, gold, science } });
}

async function handleCancelTradeRoute(req, env, ctx) {
  const { gameId, routeId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const route = await env.DB
    .prepare(
      `SELECT id, owner_faction_id, cancelled_at_tick, ship_id,
              kind, counterparty_faction_id, consolidated,
              cargo_fuel, cargo_metal, cargo_gold, cargo_science
         FROM game_trade_routes WHERE id = ? AND game_id = ?`,
    )
    .bind(routeId, gameId)
    .first();
  if (!route) return err(404, 'not_found', 'route not found');
  if (route.owner_faction_id !== me.id) return err(403, 'not_owner', 'not your route');
  if (route.cancelled_at_tick != null) return err(409, 'already_cancelled', 'already cancelled');

  // EMPTY THE CREW BEFORE YOU DELETE THE LANE (Lorne). Cancelling a
  // staffed route silently orphans every hull on it — the carriers stop
  // mid-circuit and the guards are left holding a body they were sent to
  // protect for a route that no longer exists. Making the player take
  // the ships off first turns a one-click accident into a deliberate
  // act, and it means the ships' new orders are always explicit.
  const stillCrewed = (await env.DB
    .prepare(
      `SELECT c.role, s.name FROM game_trade_route_ships c
         LEFT JOIN game_ships s ON s.id = c.ship_id
        WHERE c.route_id = ?`,
    )
    .bind(routeId)
    .all()).results ?? [];
  // …EXCEPT THE PINNED CARRIER, which cannot be taken off.
  //
  // A non-walker route (terraform, dyson, an agreement leg) flies ONE
  // pinned freighter, and handleRemoveShip refuses to detach it with
  // "cancel the route instead". So the two rules pointed at each other:
  // remove said cancel, cancel said remove, and a terraform route could
  // not be deleted by any sequence of clicks. The player saw it vanish
  // (optimistic) and come back on the next /state poll, every time —
  // reported 2026-08-16 as "every time I cancel the route it re-adds it".
  //
  // The rule's stated purpose is that no hull is ever silently orphaned.
  // That holds for GUARDS, who would be left protecting nothing, and for
  // a walker crew mid-circuit. It cannot hold for a carrier whose ONLY
  // exit is this very call — cancelling IS how it is released, and the
  // code below already banks its cargo and frees it explicitly.
  const walkerKind = route.kind === 'logistics'
    && (!route.counterparty_faction_id || route.consolidated === 1);
  const blocking = walkerKind
    ? stillCrewed
    : stillCrewed.filter(c => c.role !== 'carrier');
  if (blocking.length > 0) {
    const names = blocking.map(c => c.name).filter(Boolean).join(', ');
    return err(409, 'still_crewed',
      `take every ship off this route first${names ? ` — still aboard: ${names}` : ''}`);
  }

  // Cargo STAYS IN THE HOLD (Lorne). This used to refund the load to
  // the faction pool — a teleport home from wherever the freighter was,
  // which made cancelling a route the fastest freight service in the
  // game. The goods now move to the ship's own cargo columns and ride
  // along until delivered: fold into the next route (create-route picks
  // the hold up and hauls it to the new destination) or unload manually
  // from the ship panel.
  const game = await env.DB.prepare('SELECT current_tick FROM games WHERE id = ?').bind(gameId).first();
  const tick = game?.current_tick ?? 0;
  const fuel    = Number(route.cargo_fuel    ?? 0);
  const metal   = Number(route.cargo_metal   ?? 0);
  const gold    = Number(route.cargo_gold    ?? 0);
  const science = Number(route.cargo_science ?? 0);
  // Guarded flip + move-only-if-changed (see handleCancelBuild) so two
  // concurrent cancels can't both bank the cargo.
  // TRADE V2: crew rows are the cargo authority for walker kinds, and
  // the route columns are just the primary's mirror — moving BOTH to
  // the primary's hold would double its cargo. Each carrier keeps what
  // it was hauling; every crew row is released.
  const crewRows = (await env.DB
    .prepare('SELECT id, ship_id, role, cargo_fuel, cargo_metal, cargo_gold, cargo_science FROM game_trade_route_ships WHERE route_id = ?')
    .bind(routeId)
    .all()).results ?? [];
  const primaryHasCrewRow = crewRows.some(c => c.ship_id === route.ship_id && c.role === 'carrier');
  const flip = await env.DB
    .prepare('UPDATE game_trade_routes SET cancelled_at_tick = ?, cargo_fuel = 0, cargo_metal = 0, cargo_gold = 0, cargo_science = 0 WHERE id = ? AND cancelled_at_tick IS NULL')
    .bind(tick, routeId)
    .run();
  if (!flip.meta?.changes) return err(409, 'already_cancelled', 'already cancelled');
  for (const c of crewRows) {
    const cf = Number(c.cargo_fuel ?? 0), cm = Number(c.cargo_metal ?? 0);
    const cg = Number(c.cargo_gold ?? 0), cs = Number(c.cargo_science ?? 0);
    if (c.role === 'carrier' && cf + cm + cg + cs > 0) {
      await env.DB
        .prepare('UPDATE game_ships SET cargo_fuel = cargo_fuel + ?, cargo_metal = cargo_metal + ?, cargo_gold = cargo_gold + ?, cargo_science = cargo_science + ? WHERE id = ?')
        .bind(cf, cm, cg, cs, c.ship_id)
        .run();
    }
    await env.DB.prepare('DELETE FROM game_trade_route_ships WHERE id = ?').bind(c.id).run();
  }
  // RELEASE THE ROUTE ROW'S CARGO — gated on KIND, not on whether a crew
  // row happens to exist.
  //
  // Migration 0089 sets cargo authority by kind: walker kinds (self-haul
  // logistics + consolidated lanes) own cargo on the CARRIER ROW, and the
  // route columns are only a display mirror of the primary; legacy kinds
  // (terraform, dyson, agreement legs) own it on the ROUTE ROW. The old
  // `!primaryHasCrewRow` test used "has a crew row" as a proxy for "crew
  // row is authoritative", and those are different questions — Trade v2
  // backfilled crew rows onto every route, terraform included.
  //
  // So a terraform route had BOTH a crew row (carrying nothing, because
  // its cargo lives on the route) and route-row cargo. The flip above
  // zeroed the route columns, the crew loop moved a crew row holding
  // zero, and this branch was skipped because the crew row existed. The
  // load simply ceased to exist: 124 metal and 124 credits, debited from
  // the pool at pickup, gone on cancel with an empty hold to show for it.
  // Reported 2026-08-16: "I think it ate my 124 metal and 124 credits."
  //
  // Keeping the walker case guarded is still right — there the route
  // columns duplicate the primary's crew row, and paying both would hand
  // the player a free copy of the load.
  const routeCargoIsAuthoritative = !walkerKind;
  const releaseRouteCargo = routeCargoIsAuthoritative || !primaryHasCrewRow;
  if (releaseRouteCargo && fuel + metal + gold + science > 0) {
    await env.DB
      .prepare('UPDATE game_ships SET cargo_fuel = cargo_fuel + ?, cargo_metal = cargo_metal + ?, cargo_gold = cargo_gold + ?, cargo_science = cargo_science + ? WHERE id = ?')
      .bind(fuel, metal, gold, science, route.ship_id)
      .run();
  }

  return json({ ok: true, kept_aboard: { fuel, metal, gold, science } });
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

  // Construction 6 — the engineering victory path is deep in the tree
  // on purpose, so nobody opens with it.
  const dysonGate = await requireFeature(env, gameId, me.id, 'dyson');
  if (dysonGate) return dysonGate;

  // Slot check — only one sphere per match, but the slot REOPENS when
  // the incumbent's foundation is destroyed. King of the hill (Sean's
  // rule): progress survives the change of hands, and the next claimant
  // RESUMES construction instead of starting over.
  const game = await env.DB
    .prepare(
      `SELECT dyson_controller_faction_id, dyson_max_hp,
              dyson_acc_fuel, dyson_acc_ore, dyson_acc_credits, dyson_acc_science
         FROM games WHERE id = ?`,
    )
    .bind(gameId)
    .first();
  if (game?.dyson_controller_faction_id) {
    return err(409, 'slot_taken', 'a Dyson Sphere is already under construction this match');
  }
  const priorMax = game?.dyson_max_hp ?? 0;
  const priorAcc = (game?.dyson_acc_fuel ?? 0) + (game?.dyson_acc_ore ?? 0)
    + (game?.dyson_acc_credits ?? 0) + (game?.dyson_acc_science ?? 0);
  const resuming = priorMax > 0;

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

  // Guarded on the slot STILL being open (QA): the read-check above and
  // this write aren't atomic, and initiate isn't serialized through the
  // room DO — two racing initiates could both pass the check and both
  // get a 201 while one silently overwrote the other. The guard makes
  // SQLite pick exactly one winner; the loser gets the same 409 the
  // pre-check would have given it.
  // Two write shapes, same race guard. RESUME keeps the accumulated
  // progress and the stored targets exactly as the fallen builder left
  // them — that inheritance is the whole point of king-of-the-hill.
  // FRESH seeds from config as before. Both refuse to fire if someone
  // else claimed between the read above and this write.
  const claim = resuming
    ? await env.DB
      .prepare(
        `UPDATE games SET
           dyson_controller_faction_id = ?,
           dyson_foundation_settlement_id = ?,
           dyson_started_at_tick = ?,
           dyson_station_last_hp = NULL
         WHERE id = ? AND dyson_controller_faction_id IS NULL`,
      )
      .bind(me.id, stationId, tick, gameId)
      .run()
    : await env.DB
      .prepare(
        `UPDATE games SET
           dyson_controller_faction_id = ?,
           dyson_foundation_settlement_id = ?,
           dyson_started_at_tick = ?,
           dyson_acc_fuel = 0, dyson_acc_ore = 0, dyson_acc_credits = 0, dyson_acc_science = 0,
           dyson_target_fuel = ?, dyson_target_ore = ?, dyson_target_credits = ?, dyson_target_science = ?,
           dyson_hp = 0, dyson_max_hp = ?
         WHERE id = ? AND dyson_controller_faction_id IS NULL`,
      )
      .bind(
        me.id, stationId, tick,
        DYSON_TARGET.fuel, DYSON_TARGET.ore, DYSON_TARGET.credits, DYSON_TARGET.science,
        DYSON_MAX_HP,
        gameId,
      )
      .run();
  if (!claim.meta?.changes) {
    return err(409, 'slot_taken', 'a Dyson Sphere is already under construction this match');
  }

  // Chronicle the initiation — laying a Dyson foundation is a
  // declaration of intent to WIN and everyone deserves to hear it.
  // The herald/digest treats dyson kinds as headline news.
  try {
    const fac = await env.DB
      .prepare('SELECT name FROM game_factions WHERE id = ?')
      .bind(me.id).first();
    // OR IGNORE + station id in the key (QA): a collapse-then-reinitiate
    // in the same tick is legitimate, and a bare game+tick key made the
    // second insert a swallowed PK violation — the headline story of the
    // edition, silently dropped.
    // A resume is a different story from a groundbreaking: the claimant
    // seized someone else's half-built wonder.
    const kind = resuming ? 'dyson_claimed' : 'dyson_initiated';
    const payload = resuming
      ? {
        faction_name: fac?.name ?? null,
        inherited_progress: Math.round(priorAcc),
        max_hp: Math.round(priorMax),
        pct: priorMax > 0 ? Math.round((priorAcc / priorMax) * 100) : 0,
      }
      : { faction_name: fac?.name ?? null, target_total: DYSON_MAX_HP };
    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO chronicle_entries
          (id, game_id, tick_number, kind, actor_faction_id, body_id, payload, visibility, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'public', ?)`,
      )
      .bind(`c_dyi_${stationId}_${tick}`, gameId, tick, kind, me.id, `${gameId}:sol`,
            JSON.stringify(payload),
            Date.now())
      .run();
  } catch (e) { console.error('dyson_initiated chronicle insert failed', e); }

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

  // Metal debit, GUARDED and taken here rather than inside the plan batch.
  // `me.metal` is a snapshot: two racing launches both passed this check and
  // both debited, which could drive the pool negative and make the next
  // legitimate spend report "insufficient" with the metal already gone.
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

  // Charge LAST, immediately before the write, and guarded. Position matters
  // as much as the guard: every `return err` in this handler is above this
  // line, so there is no path that takes the metal and then rejects.
  if (metalCost > 0) {
    const paidRam = await env.DB
      .prepare('UPDATE game_factions SET metal = metal - ? WHERE id = ? AND metal >= ?')
      .bind(metalCost, me.id, metalCost)
      .run();
    if (!paidRam.meta?.changes) {
      return err(409, 'insufficient_resources',
        `need ${metalCost} metal to ram — your balance changed while the request was `
        + 'in flight. Nothing was taken.');
    }
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
    // NOTE: this asteroid-launch debit is charged in the guarded pre-check
    // above; kept out of the batch so a racing launch can't pay twice.
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
    // `fuelCost` here was a ReferenceError: no such binding exists in
    // this function — it is a local of handleTransfer, several hundred
    // lines up. Left behind when the ram switched from fuel to metal,
    // so EVERY ram attempt 500'd on the last line of a handler that had
    // already charged the metal and written the plan. Nothing caught it
    // because the feature was simultaneously unreachable, so no request
    // ever got this far. Found by actually firing one.
    metal_cost: metalCost,
    fuel_cost: metalCost,   // legacy field name, for an older bundle
  }, { status: 201 });
}

// PATCH /api/games/:gameId/ships/orders
// body: { ship_ids: string[], stance?, retreat_hp_pct?, detonate_hp_pct?,
//         target_priority? }  — target_priority: null = auto, or a ranked
// permutation of TARGET_PRIORITY_KEYS (migration 0064).
//
// Bulk standing-orders update (DESIGN-identity-economy.md §3). Fields are
// optional-but-at-least-one; an explicitly-null retreat/detonate value
// clears the threshold ("off"). Ownership is all-or-nothing: if ANY ship
// in the list is missing, destroyed, or owned by someone else, the whole
// request is rejected and no ship is touched.
const STANCES = new Set(['attack', 'defensive', 'hold']);
const RETREAT_PCTS = new Set([25, 50, 75]);
const DETONATE_PCTS = new Set([25, 50]);
// Target-priority category keys (migration 0064). A custom priority must
// be a PERMUTATION of this exact set — every category ranked, none
// duplicated — so the combat loop never falls off the end of the list.
const TARGET_PRIORITY_KEYS = ['corvette', 'frigate', 'destroyer', 'civilian', 'settlement'];

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
  const hasPriority = 'target_priority' in body;
  if (!hasStance && !hasRetreat && !hasDetonate && !hasPriority) {
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
  // target_priority: null = auto (peer targeting), or a full permutation
  // of TARGET_PRIORITY_KEYS. Stored as a canonical JSON string.
  let priorityJson = null;
  if (hasPriority && body.target_priority !== null) {
    const p = body.target_priority;
    const valid = Array.isArray(p)
      && p.length === TARGET_PRIORITY_KEYS.length
      && new Set(p).size === p.length
      && p.every(k => TARGET_PRIORITY_KEYS.includes(k));
    if (!valid) {
      return err(400, 'bad_request',
        `target_priority must be null or a permutation of ${TARGET_PRIORITY_KEYS.join(', ')}`);
    }
    // Settlements are PINNED LAST — a fleet has to be beaten before what
    // it defends can be shot at. Normalized rather than rejected: the UI
    // already locks the card, so a payload with it elsewhere is a stale
    // client or a forged request, and silently sorting it is friendlier
    // than a 400 the player can't act on. The combat loop enforces this
    // independently (room.js), so this is defence in depth, not the
    // only guard.
    const pinned = [...p.filter(k => k !== 'settlement'), 'settlement'];
    priorityJson = JSON.stringify(pinned);
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
  if (hasPriority) { sets.push('target_priority = ?'); binds.push(priorityJson); }
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
      ...(hasPriority ? { target_priority: priorityJson ? JSON.parse(priorityJson) : null } : {}),
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
  const partsGate = await requireParts(env, gameId, me.id, v.parts);
  if (partsGate) return partsGate;
  let iconVariant = null;
  if (body.icon_variant != null) {
    const badIcon = await validateIconVariant(env, ctx.session.user_id, body.icon_variant);
    if (badIcon) return err(badIcon.code === 'premium_required' ? 403 : 400, badIcon.code, badIcon.message);
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
    const partsGate = await requireParts(env, gameId, me.id, v.parts);
    if (partsGate) return partsGate;
    partsJson = v.parts.length > 0 ? JSON.stringify(v.parts) : null;
  }
  let iconVariant = row.icon_variant ?? null;
  if (body.icon_variant !== undefined) {
    if (body.icon_variant === null) iconVariant = null;
    else {
      const badIcon = await validateIconVariant(env, ctx.session.user_id, body.icon_variant);
      if (badIcon) return err(badIcon.code === 'premium_required' ? 403 : 400, badIcon.code, badIcon.message);
      iconVariant = body.icon_variant;
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

// POST /api/games/:gameId/designs/:designId/refit-fleet
// (DESIGN-fleet-economy §2)
//
// Propagate a template to every live hull of its class. Fee per ship =
// half the ADDED parts' escalated price (refitFee — removals refund
// nothing, kept copies are free). Ships parked at a body where the
// caller has a living settlement refit IMMEDIATELY (charged now, pool
// only); everything else — in transit, at hostile/empty bodies, or
// unaffordable right now — gets refit_pending_design_id stamped and is
// refitted + charged by the room tick pass when it's next parked at a
// friendly yard with funds available.
async function handleRefitFleet(req, env, ctx) {
  const { gameId, designId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const design = await env.DB
    .prepare('SELECT id, faction_id, ship_class, parts_json FROM game_ship_designs WHERE id = ? AND game_id = ?')
    .bind(designId, gameId)
    .first();
  if (!design) return err(404, 'not_found', 'design not found');
  if (design.faction_id !== me.id) return err(403, 'not_owner', 'not your design');
  const newParts = parsePartsJson(design.ship_class, design.parts_json);
  // Research gate: refitting INTO locked parts is building them.
  const gate = await requireParts(env, gameId, me.id, newParts);
  if (gate) return gate;

  const ships = (await env.DB
    .prepare(
      `SELECT id, parent_body_id, hp, hp_max, parts_json, refit_pending_design_id
         FROM game_ships
        WHERE game_id = ? AND owner_faction_id = ? AND ship_class = ? AND status = 'active'
        ORDER BY id ASC`,
    )
    .bind(gameId, me.id, design.ship_class)
    .all()).results ?? [];
  if (ships.length === 0) return json({ ok: true, refitted: [], pending: [], charged: { metal: 0, gold: 0 } });

  // In-flight hulls can't dock a refit mid-burn.
  const movingIds = new Set(
    ((await env.DB
      .prepare(
        `SELECT DISTINCT ship_id FROM game_ship_nodes
          WHERE game_id = ? AND status IN ('committed', 'in_transit')`,
      )
      .bind(gameId)
      .all()).results ?? []).map(r => r.ship_id),
  );
  // "Friendly yard" = same gate handleQueueBuild uses: a living
  // settlement of the caller's at the body.
  const yardBodies = new Set(
    ((await env.DB
      .prepare(
        `SELECT DISTINCT body_id FROM game_settlements
          WHERE game_id = ? AND owner_faction_id = ? AND destroyed_at_tick IS NULL`,
      )
      .bind(gameId, me.id)
      .all()).results ?? []).map(r => r.body_id),
  );
  const techRows = (await env.DB
    .prepare(
      `SELECT tech_id, level FROM faction_techs
        WHERE game_id = ? AND faction_id = ?
          AND tech_id IN ('weapons', 'energy_weapons', 'armor', 'shields')`,
    )
    .bind(gameId, me.id)
    .all()).results ?? [];
  const techLevels = Object.fromEntries(techRows.map(r => [r.tech_id, r.level ?? 0]));

  const normalize = (parts) => [...parts].sort().join(',');
  const targetKey = normalize(newParts);
  const stats = computeShipStats(design.ship_class, newParts, techLevels);
  const newPartsJson = newParts.length > 0 ? JSON.stringify(newParts) : null;

  let poolMetal = Number(me.metal ?? 0);
  let poolGold = Number(me.gold ?? 0);
  let chargedMetal = 0, chargedGold = 0;
  const refitted = [];
  const pending = [];
  const stmts = [];
  for (const s of ships) {
    const curParts = parsePartsJson(design.ship_class, s.parts_json);
    if (normalize(curParts) === targetKey) {
      // Already matches — clear a stale pending marker if one exists.
      if (s.refit_pending_design_id) {
        stmts.push(env.DB
          .prepare('UPDATE game_ships SET refit_pending_design_id = NULL WHERE id = ?')
          .bind(s.id));
      }
      continue;
    }
    const fee = refitFee(curParts, newParts);
    const atYard = !movingIds.has(s.id) && yardBodies.has(s.parent_body_id);
    const affordable = fee.metal <= poolMetal && fee.gold <= poolGold;
    if (atYard && affordable) {
      poolMetal -= fee.metal;
      poolGold -= fee.gold;
      chargedMetal += fee.metal;
      chargedGold += fee.gold;
      // Preserve the DAMAGE FRACTION across the base-HP change (same
      // trick as the armor-research bump): hp scales by newBase/oldBase.
      const oldBase = Number(s.hp_max ?? 0) > 0 ? Number(s.hp_max) : stats.hp;
      const hpScale = stats.hp / oldBase;
      stmts.push(env.DB
        .prepare(
          `UPDATE game_ships
              SET parts_json = ?, hp_max = ?, hp = MIN(hp * ?, ?),
                  damage_per_tick = ?, refit_pending_design_id = NULL
            WHERE id = ?`,
        )
        .bind(newPartsJson, stats.hp, hpScale, stats.hp, stats.damage_per_tick, s.id));
      refitted.push(s.id);
    } else {
      stmts.push(env.DB
        .prepare('UPDATE game_ships SET refit_pending_design_id = ? WHERE id = ?')
        .bind(designId, s.id));
      pending.push(s.id);
    }
  }
  if (chargedMetal > 0 || chargedGold > 0) {
    // Guarded charge — if a concurrent spend drained the pool since we
    // snapshotted it, fail the whole refit rather than going negative.
    const charge = await env.DB
      .prepare(
        `UPDATE game_factions SET metal = metal - ?, gold = gold - ?
          WHERE id = ? AND metal >= ? AND gold >= ?`,
      )
      .bind(chargedMetal, chargedGold, me.id, chargedMetal, chargedGold)
      .run();
    if (!charge.meta?.changes) {
      return err(409, 'insufficient_resources', `refit needs ${chargedMetal}M ${chargedGold}G`);
    }
  }
  if (stmts.length > 0) await env.DB.batch(stmts);
  if (chargedMetal > 0 || chargedGold > 0) {
    await logSpend(env, {
      gameId, factionId: me.id, category: 'ships',
      metal: chargedMetal, gold: chargedGold,
    });
  }
  return json({
    ok: true,
    refitted,
    pending,
    charged: { metal: chargedMetal, gold: chargedGold },
  });
}

// POST /api/games/:gameId/ships/:shipId/refit   body: { design_id }
//
// ONE HULL, ORDERED IN FOR THE UPGRADE.
//
// refit-fleet already propagates a template across a whole class and
// stamps refit_pending_design_id on anything that cannot take it right
// now — and the tick pass (room.js 1c) applies it the moment such a hull
// is parked at a friendly settlement with the fee available. That half
// was entirely passive: a ship in the wrong place waited until it
// happened to come home, which for a hull on station is never.
//
// This is the active half. It stamps ONE ship, and the client pairs it
// with an ordinary transfer to the nearest settlement that can do the
// work. The apply logic is deliberately NOT duplicated here — fee,
// affordability, and the design's CURRENT parts are all resolved by the
// tick pass, so an order placed now honours a template edited later, and
// there is exactly one place that knows how to fit a loadout.
async function handleRefitShip(req, env, ctx) {
  const { gameId, shipId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  if (!SHIP_ID_RE.test(shipId)) return err(400, 'bad_request', 'invalid ship id');

  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const body = await readJson(req);
  const designId = body?.design_id;

  // OWNERSHIP IS CHECKED BEFORE EITHER BRANCH. The clear used to scope
  // its UPDATE by owner and return ok:true regardless — so the write was
  // safe, but the ANSWER was a lie: cancelling a rival's refit reported
  // success for a row it had not touched. Found by pointing the endpoint
  // at another faction's corvette.
  const ship = await env.DB
    .prepare('SELECT id, owner_faction_id, ship_class, status FROM game_ships WHERE id = ? AND game_id = ?')
    .bind(shipId, gameId)
    .first();
  if (!ship) return err(404, 'not_found', 'ship not found');
  if (ship.owner_faction_id !== me.id) return err(403, 'not_owner', 'you do not own this ship');
  if (ship.status !== 'active') return err(409, 'not_active', 'this ship is no longer active');

  // null clears a standing order — a player who changed their mind
  // should not have to fly the ship somewhere to cancel it.
  if (designId === null) {
    const res = await env.DB
      .prepare('UPDATE game_ships SET refit_pending_design_id = NULL WHERE id = ? AND refit_pending_design_id IS NOT NULL')
      .bind(shipId)
      .run();
    return json({ ok: true, cleared: !!res.meta?.changes });
  }
  if (typeof designId !== 'string' || !designId) {
    return err(400, 'bad_request', 'design_id required');
  }

  const design = await env.DB
    .prepare('SELECT id, faction_id, ship_class, parts_json FROM game_ship_designs WHERE id = ? AND game_id = ?')
    .bind(designId, gameId)
    .first();
  if (!design) return err(404, 'not_found', 'design not found');
  if (design.faction_id !== me.id) return err(403, 'not_owner', 'not your design');
  if (design.ship_class !== ship.ship_class) {
    return err(409, 'wrong_class', `that design is for a ${design.ship_class}, not a ${ship.ship_class}`);
  }

  // Research gate at ORDER time as well as apply time. The tick pass
  // would silently decline a locked loadout; a player deserves to be
  // told now rather than watch a ship fly home and do nothing.
  const gate = await requireParts(env, gameId, me.id, parsePartsJson(design.ship_class, design.parts_json));
  if (gate) return gate;

  await env.DB
    .prepare('UPDATE game_ships SET refit_pending_design_id = ? WHERE id = ?')
    .bind(designId, shipId)
    .run();

  return json({ ok: true, ship_id: shipId, design_id: designId });
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

// PUT /api/games/:gameId/build-list
//
// Replace the caller's curated build list (migration 0045) wholesale.
// The client owns ordering, so it always sends the full array — this
// sidesteps add/remove race conditions across concurrent shipyards.
// body: { entries: Array<{ design_id: string } | { bare_class: string }> }
async function handleSetBuildList(req, env, ctx) {
  const { gameId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');

  const body = await readJson(req);
  if (!body || !Array.isArray(body.entries)) return err(400, 'bad_request', 'entries[] required');
  if (body.entries.length > 40) return err(400, 'bad_request', 'build list too long (max 40)');

  // Every design id the caller owns, so we can drop stale references
  // (a design deleted from another tab) instead of persisting dangling
  // rows. One query rather than per-entry lookups.
  const owned = new Set(
    ((await env.DB
      .prepare('SELECT id FROM game_ship_designs WHERE game_id = ? AND faction_id = ?')
      .bind(gameId, me.id)
      .all()).results ?? []).map(r => r.id),
  );

  const clean = [];
  for (const e of body.entries) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.design_id === 'string' && owned.has(e.design_id)) {
      clean.push({ design_id: e.design_id });
    } else if (typeof e.bare_class === 'string' && SHIP_CLASSES.has(e.bare_class)) {
      clean.push({ bare_class: e.bare_class });
    }
    // else: unknown/stale entry — silently dropped.
  }

  await env.DB
    .prepare('UPDATE game_factions SET build_list_json = ? WHERE id = ?')
    .bind(JSON.stringify(clean), me.id)
    .run();

  return json({ build_list: clean });
}

// ============================================================
// Captains (DESIGN-captains.md §5) — bank management.
//   POST  /api/games/:gid/captains                — create (bank, unassigned)
//   PATCH /api/games/:gid/captains/:captainId     — rename / avatar / bio
//   POST  /api/games/:gid/captains/:captainId/assign — { ship_id | null }
// ============================================================

function captainToJson(row) {
  return {
    id: row.id, name: row.name, avatar_id: row.avatar_id, bio: row.bio,
    rank: row.rank ?? 0, traits_json: row.traits_json ?? null,
    ship_id: row.ship_id ?? null, status: row.status,
    created_at_tick: row.created_at_tick ?? 0, lost_at_tick: row.lost_at_tick ?? null,
    benched_at_tick: row.benched_at_tick ?? null,
  };
}

async function requireMyCaptain(env, gameId, userId, captainId) {
  const me = await requireMyFaction(env, gameId, userId);
  if (!me) return { err: err(403, 'not_member', 'not in this game') };
  const cap = await env.DB
    .prepare('SELECT * FROM game_captains WHERE id = ? AND game_id = ?')
    .bind(captainId, gameId).first();
  if (!cap) return { err: err(404, 'not_found', 'captain not found') };
  if (cap.faction_id !== me.id) return { err: err(403, 'not_owner', 'not your captain') };
  return { me, cap };
}

async function handleCreateCaptain(req, env, ctx) {
  const { gameId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  const me = await requireMyFaction(env, gameId, ctx.session.user_id);
  if (!me) return err(403, 'not_member', 'not in this game');
  const body = (await readJson(req)) ?? {};

  // Bank cap: 20 unassigned per faction — enough to pre-stage a fleet,
  // low enough that the roster UI stays a list, not a database.
  const bankCount = await env.DB
    .prepare(`SELECT COUNT(*) AS c FROM game_captains
               WHERE game_id = ? AND faction_id = ? AND ship_id IS NULL AND status = 'active'`)
    .bind(gameId, me.id).first();
  if ((bankCount?.c ?? 0) >= 20) return err(409, 'bank_full', 'captain bank is full (20 unassigned max)');

  // Recruiting costs metal + credits (DESIGN-captains economy update):
  // every faction fields STARTING_CAPTAINS for free via the floor pass;
  // past that, officers are bought.
  //
  // The old note here claimed that debiting "in the same batch as the insert"
  // stopped a double-click recruiting two captains for one payment. It does
  // not: a batch is atomic within ONE request, and a double-click is two
  // requests with two batches, both of which passed this same stale check.
  // The charge is now guarded and happens first, so the second request's
  // debit simply misses and it is rejected having taken nothing.
  if ((me.metal ?? 0) < RECRUIT_COST.metal || (me.gold ?? 0) < RECRUIT_COST.gold) {
    return err(409, 'cannot_afford',
      `recruiting a captain costs ${RECRUIT_COST.metal}M + ${RECRUIT_COST.gold}C`);
  }

  const game = await env.DB.prepare('SELECT current_tick FROM games WHERE id = ?').bind(gameId).first();
  const tick = game?.current_tick ?? 0;
  const names = new Set(
    ((await env.DB.prepare(`SELECT name FROM game_captains WHERE game_id = ? AND status = 'active'`)
      .bind(gameId).all()).results ?? []).map(r => r.name),
  );
  const c = rollCaptain(gameId, me.id, tick, names, Math.floor(Math.random() * 1e6));
  // Player-typed name wins over the roll (still ≤32 chars like ships).
  let name = c.name;
  if (typeof body.name === 'string' && body.name.trim().length > 0) {
    name = body.name.trim().slice(0, 32);
  }
  const paidCaptain = await env.DB
    .prepare(
      `UPDATE game_factions SET metal = metal - ?, gold = gold - ?
        WHERE id = ? AND metal >= ? AND gold >= ?`,
    )
    .bind(RECRUIT_COST.metal, RECRUIT_COST.gold, me.id, RECRUIT_COST.metal, RECRUIT_COST.gold)
    .run();
  if (!paidCaptain.meta?.changes) {
    return err(409, 'cannot_afford',
      `recruiting a captain costs ${RECRUIT_COST.metal}M + ${RECRUIT_COST.gold}C — `
      + 'your balance changed while the request was in flight. Nothing was taken.');
  }

  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO game_captains
           (id, game_id, faction_id, name, avatar_id, bio, rank, traits_json, ship_id,
            status, created_at_tick, benched_at_tick)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL, 'active', ?, ?)`,
      )
      // Benched on arrival (migration 0051): a recruit is a deliberate
      // purchase, almost always for a hull the player has in mind. Left
      // auto-assignable, ensureCaptains would post them to a random
      // orphan ship on the very next tick — the player pays 50M+100C and
      // the game picks the posting. The free STARTING_CAPTAINS floor is
      // NOT benched; that one's meant to self-distribute.
      .bind(c.id, gameId, me.id, name, c.avatar_id, c.bio, JSON.stringify(c.traits), tick, tick),
  ]);
  const row = await env.DB.prepare('SELECT * FROM game_captains WHERE id = ?').bind(c.id).first();
  return json({ captain: captainToJson(row) }, { status: 201 });
}

async function handlePatchCaptain(req, env, ctx) {
  const { gameId, captainId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  const got = await requireMyCaptain(env, gameId, ctx.session.user_id, captainId);
  if (got.err) return got.err;
  const body = (await readJson(req)) ?? {};

  let name = got.cap.name;
  if (typeof body.name === 'string' && body.name.trim().length > 0) {
    name = body.name.trim().slice(0, 32);
  }
  let avatar = got.cap.avatar_id;
  if (typeof body.avatar_id === 'string') {
    if (!AVATAR_IDS.includes(body.avatar_id)) return err(400, 'bad_request', 'unknown avatar_id');
    avatar = body.avatar_id;
  }
  let bio = got.cap.bio;
  if (typeof body.bio === 'string') bio = body.bio.slice(0, 240);

  await env.DB
    .prepare('UPDATE game_captains SET name = ?, avatar_id = ?, bio = ? WHERE id = ?')
    .bind(name, avatar, bio, captainId)
    .run();
  const row = await env.DB.prepare('SELECT * FROM game_captains WHERE id = ?').bind(captainId).first();
  return json({ captain: captainToJson(row) });
}

async function handleAssignCaptain(req, env, ctx) {
  const { gameId, captainId } = ctx.params;
  if (!GAME_ID_RE.test(gameId)) return err(400, 'bad_request', 'invalid game id');
  const got = await requireMyCaptain(env, gameId, ctx.session.user_id, captainId);
  if (got.err) return got.err;
  if (got.cap.status !== 'active') return err(409, 'captain_lost', 'this captain was lost in action');
  const body = (await readJson(req)) ?? {};
  const shipId = body.ship_id ?? null;

  // One captain per fleet: members surrendered theirs on joining, and
  // the bank must not re-officer them through the side door. Assigning
  // to a fleet member is only legal via the fleet PROMOTE flow (which
  // also raises them to flag).
  if (shipId) {
    // Scoped to the CALLER's ships on purpose. Unscoped, this peek ran
    // before the ownership check further down, so a 409 'fleet_member'
    // vs a fall-through told you whether an arbitrary ship id — including
    // a rival's, anywhere on the map — was in a fleet. That is a fog-of-war
    // leak through an error code: no board state is revealed by the UI, but
    // the API answered the question anyway. Scoping the lookup means a
    // ship that isn't yours simply isn't found here, and the real 403
    // below is what you get.
    const tgt = await env.DB
      .prepare('SELECT fleet_id FROM game_ships WHERE id = ? AND game_id = ? AND owner_faction_id = ?')
      .bind(shipId, gameId, got.me.id)
      .first();
    if (tgt?.fleet_id) {
      return err(409, 'fleet_member',
        'fleet members sail under the flag captain — use PROMOTE to give this ship the flag');
    }
  }

  // Current tick stamps the bench (migration 0051) so ensureCaptains
  // knows this captain is in reserve BY CHOICE and must not be auto-
  // posted to a random orphan hull next tick.
  const gameRow = await env.DB
    .prepare('SELECT current_tick FROM games WHERE id = ?').bind(gameId).first();
  const nowTick = gameRow?.current_tick ?? 0;

  // You cannot change command under fire. Checked on the captain's CURRENT
  // post first because that hull is definitionally yours — the destination
  // is checked further down, after ownership, so this never becomes an
  // oracle for whether some rival hull is in a fight (same fog-of-war
  // reasoning as the fleet_member peek above).
  if (got.cap.ship_id) {
    const hot = await shipsInCombat(env.DB, gameId, [got.cap.ship_id], nowTick);
    if (hot.has(got.cap.ship_id)) {
      return err(409, 'in_combat',
        'this captain is under fire — you cannot relieve them mid-battle');
    }
  }

  const stmts = [];
  // Detach from current post (if any).
  if (got.cap.ship_id) {
    stmts.push(env.DB.prepare('UPDATE game_ships SET captain_id = NULL WHERE id = ?').bind(got.cap.ship_id));
  }
  if (shipId === null) {
    stmts.push(env.DB
      .prepare('UPDATE game_captains SET ship_id = NULL, benched_at_tick = ? WHERE id = ?')
      .bind(nowTick, captainId));
    await env.DB.batch(stmts);
    // No logSpend here: benching is free. This used to log a full
    // RECRUIT_COST against the captains budget — and did it through an
    // unbound `me`, so the throw landed AFTER the batch had committed and
    // every bench returned a 500 on a change that had already happened.
    return json({ ok: true, captain_id: captainId, ship_id: null });
  }
  if (typeof shipId !== 'string') return err(400, 'bad_request', 'ship_id must be a string or null');
  const ship = await env.DB
    .prepare(`SELECT id, owner_faction_id, captain_id FROM game_ships
               WHERE id = ? AND game_id = ? AND status = 'active'`)
    .bind(shipId, gameId).first();
  if (!ship) return err(404, 'not_found', 'ship not found');
  if (ship.owner_faction_id !== got.me.id) return err(403, 'not_owner', 'not your ship');
  // Ownership is settled, so this can't leak a rival's combat state. Blocks
  // both halves of the swap: posting a captain onto a hull that's taking
  // fire, and displacing the one already aboard it.
  {
    const hot = await shipsInCombat(env.DB, gameId, [shipId], nowTick);
    if (hot.has(shipId)) {
      return err(409, 'in_combat',
        ship.captain_id && ship.captain_id !== captainId
          ? 'that ship is in combat — its captain stays at their post'
          : 'that ship is in combat — no one is boarding it mid-battle');
    }
  }
  // The target ship's sitting captain (if different) goes to the bank —
  // assignment is a swap-to-bench, never a delete. Stamped as benched
  // for the same reason as an explicit bench: the displacement was a
  // player decision, so auto-assign must not immediately re-post them
  // onto some unrelated hull.
  if (ship.captain_id && ship.captain_id !== captainId) {
    stmts.push(env.DB
      .prepare('UPDATE game_captains SET ship_id = NULL, benched_at_tick = ? WHERE id = ?')
      .bind(nowTick, ship.captain_id));
  }
  // Taking a post clears the bench — this captain is in service again.
  stmts.push(env.DB
    .prepare('UPDATE game_captains SET ship_id = ?, benched_at_tick = NULL WHERE id = ?')
    .bind(shipId, captainId));
  stmts.push(env.DB.prepare('UPDATE game_ships SET captain_id = ? WHERE id = ?').bind(captainId, shipId));
  await env.DB.batch(stmts);
  return json({ ok: true, captain_id: captainId, ship_id: shipId });
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
      // HULL AT THE MOMENT OF THE DECISION. Toll alone cannot tell a weapon
      // from a last resort: a ship detonating at full health was SENT to do
      // it, and one going up at eight percent was going to die anyway. The
      // Herald reads this to pick its register, so it has to be captured
      // here -- after the fact the hull is gone and its hp is zero.
      hp_pct: (ship.hp_max ?? 0) > 0
        ? Math.max(0, Math.min(100, Math.round(((ship.hp ?? 0) / ship.hp_max) * 100)))
        : null,
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

    // Captain survival rolls (DESIGN-captains §2.1) — the detonating hull
    // and every victim destroyed by the blast. Chronicle each outcome.
    const deadIds = [shipId, ...victimSummaries.filter(v => v.destroyed).map(v => v.ship_id)];
    for (const dead of deadIds) {
      try {
        const fate = await resolveCaptainOnDeath(env.DB, gameId, tick, dead);
        if (fate) {
          await env.DB
            .prepare(
              `INSERT INTO chronicle_entries
                (id, game_id, tick_number, kind, actor_faction_id, body_id, payload, visibility, created_at_ms)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'public', ?)`,
            )
            .bind(`c_det_cap_${dead.slice(-10)}_${tick}`, gameId, tick,
                  fate.outcome === 'rescued' ? 'captain_rescued' : 'captain_lost',
                  fate.captain.faction_id, ship.parent_body_id,
                  JSON.stringify({
                    captain_id: fate.captain.id,
                    captain_name: fate.captain.name,
                    captain_rank: fate.captain.rank ?? 0,
                    // The combat path (worker/room.js) has always stamped this;
                    // the detonate path did not, so an officer who went up with
                    // their own charge reached the Herald's obituary column with
                    // no hull to name.
                    ship_name: ship?.name ?? null,
                    body_name: bodyRow?.name ?? null,
                  }),
                  Date.now())
            .run();
        }
      } catch (e) { console.error('detonate captain roll failed', e); }
    }
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
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/designs\/(?<designId>[^/]+)\/refit-fleet$/,
    auth: 'required',
    handle: handleRefitFleet,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/ships\/(?<shipId>[^/]+)\/refit$/,
    auth: 'required',
    handle: handleRefitShip,
  },
  {
    method: 'PUT',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/build-list$/,
    auth: 'required',
    handle: handleSetBuildList,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/captains$/,
    auth: 'required',
    handle: handleCreateCaptain,
  },
  {
    // MUST precede the bare :captainId PATCH-style routes — 'assign' is a
    // literal segment the generic pattern would swallow.
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/captains\/(?<captainId>[^/]+)\/assign$/,
    auth: 'required',
    handle: handleAssignCaptain,
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/captains\/(?<captainId>[^/]+)$/,
    auth: 'required',
    handle: handlePatchCaptain,
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
    method: 'GET',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/herald$/,
    auth: 'required',
    handle: handleGetHerald,
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
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/ships\/(?<shipId>[^/]+)\/mine$/,
    auth: 'required',
    handle: handleSetMining,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/ships\/(?<shipId>[^/]+)\/place-framework$/,
    auth: 'required',
    handle: handlePlaceFramework,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/megastructures\/(?<siteId>[^/]+)\/deliver$/,
    auth: 'required',
    handle: handleDeliverToSite,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/megastructures\/(?<siteId>[^/]+)\/pair$/,
    auth: 'required',
    handle: handlePairGate,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/ships\/(?<shipId>[^/]+)\/gate$/,
    auth: 'required',
    handle: handleGateTransit,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/ships\/(?<shipId>[^/]+)\/unload-hold$/,
    auth: 'required',
    handle: handleUnloadHold,
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/builds\/(?<orderId>[^/]+)$/,
    auth: 'required',
    handle: handleCancelBuild,
  },
  {
    method: 'POST',
    pattern: /^\/api\/games\/(?<gameId>[^/]+)\/builds\/(?<orderId>[^/]+)\/rush$/,
    auth: 'required',
    handle: handleRushBuild,
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
