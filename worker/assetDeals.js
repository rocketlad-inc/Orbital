// ============================================================
// assetDeals — selling a hull or a world for freight.
//
// Trade agreements move RESOURCES on a standing lane. This is the other
// kind of deal: one-off, where the thing changing hands is a ship or a
// settled world and the payment is hauled in by freighter.
//
// The whole lifecycle lives here rather than in actions.js because the
// interesting part is not any single endpoint — it is the invariant that
// an asset must still be the seller's, still exist, and still be where
// the deal said it was at the MOMENT of handover. Three endpoints and a
// tick pass all need that same answer, and three copies of it would
// drift the way the supply rules did.
// ============================================================

/** A "planet" is sold by transferring the settlement standing on it:
 *  body ownership in this game is derived from settlements, so the
 *  settlement is the deed. */
export const ASSET_KINDS = new Set(['ship', 'settlement']);

/** Deals that are still live and can still be paid into. */
export const OPEN_STATUSES = ['offered', 'active'];

/**
 * Is the asset still deliverable, and where is it?
 *
 * Returns { ok, bodyId, name, reason }. Called at proposal (to find the
 * delivery point), and again at handover — because the interesting case
 * is a seller who scrapped the hull, lost the world, or simply flew it
 * somewhere else while the buyer's freighters were in flight.
 *
 * NOT called on every tick of an open deal. A hull that wanders off
 * mid-deal is not void, it is a hull the buyer now has to chase: the
 * delivery point was snapshotted at proposal and the payment goes there
 * regardless. Voiding on movement would let a seller cancel any deal
 * they regretted by taking their ship for a walk.
 */
export async function assetState(env, gameId, kind, assetId, sellerFactionId) {
  if (kind === 'ship') {
    const row = await env.DB
      .prepare(
        `SELECT id, name, owner_faction_id, status, parent_body_id
           FROM game_ships WHERE id = ? AND game_id = ?`,
      )
      .bind(assetId, gameId).first();
    if (!row) return { ok: false, reason: 'asset_gone' };
    if (row.status !== 'active') return { ok: false, reason: 'asset_gone' };
    if (row.owner_faction_id !== sellerFactionId) return { ok: false, reason: 'not_sellers' };
    return { ok: true, bodyId: row.parent_body_id, name: row.name };
  }

  if (kind === 'settlement') {
    const row = await env.DB
      .prepare(
        `SELECT s.id, s.name, s.owner_faction_id, s.body_id, s.destroyed_at_tick, b.name AS body_name
           FROM game_settlements s
           JOIN game_bodies b ON b.id = s.body_id
          WHERE s.id = ? AND s.game_id = ?`,
      )
      .bind(assetId, gameId).first();
    if (!row || row.destroyed_at_tick != null) return { ok: false, reason: 'asset_gone' };
    if (row.owner_faction_id !== sellerFactionId) return { ok: false, reason: 'not_sellers' };
    return { ok: true, bodyId: row.body_id, name: row.name ?? row.body_name };
  }

  return { ok: false, reason: 'bad_kind' };
}

/** What is still owed on a deal. */
export function owedOn(deal) {
  return {
    metal: Math.max(0, Number(deal.price_metal) - Number(deal.paid_metal)),
    credits: Math.max(0, Number(deal.price_credits) - Number(deal.paid_credits)),
  };
}

/** Paid in full? */
export function isSettled(deal) {
  const owed = owedOn(deal);
  return owed.metal <= 0 && owed.credits <= 0;
}

/** 0..1, the WORSE of the two buckets — a deal with all its metal and no
 *  credits is not half paid in any sense that matters to the seller.
 *  Same rule megastructure progress uses, for the same reason. */
export function paidFraction(deal) {
  const pm = Number(deal.price_metal) || 0;
  const pc = Number(deal.price_credits) || 0;
  if (pm <= 0 && pc <= 0) return 1;
  const fm = pm > 0 ? Math.min(1, Number(deal.paid_metal) / pm) : 1;
  const fc = pc > 0 ? Math.min(1, Number(deal.paid_credits) / pc) : 1;
  return Math.min(fm, fc);
}

/**
 * Hand the asset over and close the deal.
 *
 * Everything here is one batch: the transfer, the seller's payment, and
 * the closure. A partial application would either give away an asset
 * nobody paid for or bank a payment for an asset that never moved, and
 * both are unrecoverable from a player's point of view.
 *
 * THE SELLER IS PAID AT HANDOVER, not per delivery. Freight poured into
 * the meter is escrowed — out of the buyer's holds, not yet in the
 * seller's pool — so a seller who walks away from a half-paid deal
 * cannot keep the instalments. That is what makes it safe to pay a
 * stranger in more than one run.
 */
export async function fulfilDeal(env, gameId, deal, tick) {
  const state = await assetState(
    env, gameId, deal.asset_kind, deal.asset_id, deal.seller_faction_id,
  );
  if (!state.ok) return { ok: false, reason: state.reason };

  const transfer = deal.asset_kind === 'ship'
    ? env.DB.prepare(
      // YOU BUY A HULL, NOT THE PREVIOUS OWNER'S INSTRUCTIONS.
      //
      // Every standing order is stripped, and the armed charges matter
      // most: detonate_at_tick is a timed self-destruct, arrival_action
      // can be 'detonate', and detonate_hp_pct / detonate_on_hostile /
      // detonate_at_guard are dead-man switches. Leaving any of them set
      // would let a seller arm a hull, take payment, and watch it blow
      // up on schedule in the buyer's fleet. That is not a trade, it is
      // a delivery mechanism.
      //
      // fleet_id and the captain do not come along either: a fleet is
      // the seller's command structure and a captain is a person, not
      // cargo. The officer is released BOTH WAYS — see the crew statement
      // below — because game_captains carries its own ship_id and would
      // otherwise still name this hull.
      //
      // fleet_detached goes with fleet_id — a hull carrying the detached
      // flag into a NEW fleet would sit out its moves and look broken for
      // reasons the buyer cannot see.
      `UPDATE game_ships
          SET owner_faction_id = ?,
              fleet_id = NULL, fleet_detached = 0, captain_id = NULL,
              target_priority = NULL, mining_body_id = NULL,
              stance = NULL, retreat_hp_pct = NULL,   -- NULL means 'attack' (0034)
              refit_pending_design_id = NULL,
              strike_target_body_id = NULL, strike_ready_tick = NULL,
              arrival_action = NULL, arrival_guard = NULL,
              detonate_hp_pct = NULL, detonate_at_tick = NULL,
              detonate_at_guard = NULL,
              -- NOT NULL DEFAULT 0, like fleet_detached: reset to the
              -- default rather than nulled, or the whole batch fails a
              -- constraint and the sale cannot complete at all.
              detonate_on_hostile = 0,
              detonate_mine_mode = NULL
        WHERE id = ?`,
    ).bind(deal.buyer_faction_id, deal.asset_id)
    : env.DB.prepare(
      'UPDATE game_settlements SET owner_faction_id = ? WHERE id = ?',
    ).bind(deal.buyer_faction_id, deal.asset_id);

  // THE OFFICER STAYS WITH THE SELLER. game_captains links both ways
  // (faction_id AND ship_id), so clearing only game_ships.captain_id
  // would leave the seller's named officer listed as commanding a hull
  // that now belongs to a rival — visible on the seller's own roster,
  // and unassignable, because the captain is "already on a ship".
  //
  // Same two-sided shape as bankMemberCaptains in fleets.js, and the
  // same resting state: ship_id NULL with benched_at_tick untouched
  // means "in the bank, rank intact, ready to reassign" rather than
  // "deliberately benched", which is a player decision this is not.
  const crew = deal.asset_kind === 'ship'
    ? [env.DB.prepare(
      'UPDATE game_captains SET ship_id = NULL WHERE game_id = ? AND ship_id = ?',
    ).bind(gameId, deal.asset_id)]
    : [];

  await env.DB.batch([
    transfer,
    ...crew,
    // The escrow is released to the seller only now.
    env.DB.prepare(
      'UPDATE game_factions SET metal = metal + ?, gold = gold + ? WHERE id = ?',
    ).bind(
      Number(deal.paid_metal) || 0, Number(deal.paid_credits) || 0,
      deal.seller_faction_id,
    ),
    env.DB.prepare(
      `UPDATE trade_asset_deals
          SET status = 'fulfilled', ended_at_tick = ?
        WHERE id = ?`,
    ).bind(tick, deal.id),
  ]);

  return { ok: true, name: state.name, bodyId: state.bodyId };
}

/**
 * End a deal without a handover, refunding whatever was escrowed.
 *
 * The buyer gets their freight back because it never reached the seller
 * — it was sitting in the meter. A deal that dies because the seller
 * scrapped the hull should cost the buyer the flying time and nothing
 * else; keeping their metal as well would make every sale a coin flip
 * on the counterparty's honesty rather than a trade.
 */
export async function voidDeal(env, gameId, deal, reason, tick) {
  const stmts = [
    env.DB.prepare(
      `UPDATE trade_asset_deals
          SET status = 'void', ended_reason = ?, ended_at_tick = ?
        WHERE id = ?`,
    ).bind(reason, tick, deal.id),
  ];
  const m = Number(deal.paid_metal) || 0;
  const c = Number(deal.paid_credits) || 0;
  if (m > 0 || c > 0) {
    stmts.push(env.DB.prepare(
      'UPDATE game_factions SET metal = metal + ?, gold = gold + ? WHERE id = ?',
    ).bind(m, c, deal.buyer_faction_id));
  }
  await env.DB.batch(stmts);
  return { ok: true, refunded: { metal: m, credits: c } };
}

// ============================================================
// PAYING BY FREIGHTER — one rule for the instant unload and the tick.
//
// fartmaster (Discord), 2026-10-06: "Trading for a planet does not seem
// to work." The row's "Send a freighter…" called the UNLOAD endpoint,
// which only takes a hull already parked at the asset with the payment
// aboard -- and nothing could load a payment or fly it there. So paying
// was impossible unless a player hand-flew a loaded freighter to the
// asset, which nothing told them.
//
// Now "send" dispatches a shipment on the trade-delivery machinery
// (trade_deliveries, trade_id 'asset:<dealId>'): the freighter loads
// what is owed at the buyer's dock and hauls it, and the tick pours it
// in on arrival through payIntoDeal, the same call the instant unload
// makes. And (Lorne's call, same report) the payment may land at ANY
// of the seller's settlements as well as at the asset: handover still
// re-checks the asset in fulfilDeal, so where the freight lands cannot
// let a seller dodge the deal.
// ============================================================

export const ASSET_TRADE_PREFIX = 'asset:';

/** Where a payment may land: any live settlement of the seller, or the
 *  asset's snapshotted delivery point. */
export async function isPaymentDest(env, gameId, deal, bodyId) {
  if (!bodyId) return false;
  if (bodyId === deal.delivery_body_id) return true;
  const row = await env.DB
    .prepare(
      `SELECT 1 AS x FROM game_settlements
        WHERE game_id = ? AND body_id = ? AND owner_faction_id = ?
          AND destroyed_at_tick IS NULL LIMIT 1`,
    )
    .bind(gameId, bodyId, deal.seller_faction_id).first();
  return !!row;
}

/** Every body a payment may land at, named, for the picker. */
export async function paymentDests(env, gameId, deal) {
  const rows = (await env.DB
    .prepare(
      `SELECT DISTINCT b.id AS body_id, b.name AS body_name
         FROM game_settlements s
         JOIN game_bodies b ON b.id = s.body_id AND b.game_id = s.game_id
        WHERE s.game_id = ? AND s.owner_faction_id = ?
          AND s.destroyed_at_tick IS NULL AND b.destroyed_at_tick IS NULL
        ORDER BY b.name`,
    )
    .bind(gameId, deal.seller_faction_id).all()).results ?? [];
  const out = rows.map(r => ({ body_id: r.body_id, name: r.body_name }));
  if (!out.some(r => r.body_id === deal.delivery_body_id)) {
    const at = await env.DB.prepare('SELECT name FROM game_bodies WHERE id = ?')
      .bind(deal.delivery_body_id).first();
    out.unshift({ body_id: deal.delivery_body_id, name: at?.name ?? 'the asset' });
  }
  return out;
}

/** What freighters are already hauling toward this deal (unresolved). */
export async function inFlightFor(env, gameId, dealId) {
  const row = await env.DB
    .prepare(
      `SELECT COALESCE(SUM(metal), 0) AS m, COALESCE(SUM(gold), 0) AS g, COUNT(*) AS n
         FROM trade_deliveries
        WHERE game_id = ? AND trade_id = ? AND resolved_at_tick IS NULL`,
    )
    .bind(gameId, `${ASSET_TRADE_PREFIX}${dealId}`).first();
  return { metal: Number(row?.m ?? 0), credits: Number(row?.g ?? 0), freighters: Number(row?.n ?? 0) };
}

/**
 * Where a freighter loads a shipment: where it is, if the faction has a
 * terraformed world there (the pool is reachable), else the faction's
 * dock, the capital first. Shared with trade-agreement deliveries.
 */
export async function deliveryPickup(env, gameId, factionId, capitalBodyId, shipBodyId) {
  const dock = (bodyId) => env.DB
    .prepare(
      `SELECT 1 AS x FROM game_settlements s
         JOIN game_bodies b ON b.id = s.body_id AND b.game_id = s.game_id
        WHERE s.game_id = ? AND s.body_id = ? AND s.owner_faction_id = ?
          AND b.terraformed_at_tick IS NOT NULL
          AND s.destroyed_at_tick IS NULL AND b.destroyed_at_tick IS NULL LIMIT 1`,
    )
    .bind(gameId, bodyId, factionId).first();
  if (shipBodyId && await dock(shipBodyId)) return shipBodyId;
  const any = await env.DB
    .prepare(
      `SELECT s.body_id, CASE WHEN s.body_id = ? THEN 0 ELSE 1 END AS pref
         FROM game_settlements s
         JOIN game_bodies b ON b.id = s.body_id AND b.game_id = s.game_id
        WHERE s.game_id = ? AND s.owner_faction_id = ?
          AND b.terraformed_at_tick IS NOT NULL
          AND s.destroyed_at_tick IS NULL AND b.destroyed_at_tick IS NULL
        ORDER BY pref LIMIT 1`,
    )
    .bind(capitalBodyId ?? '', gameId, factionId).first();
  return any?.body_id ?? null;
}

/**
 * Pour freight into a deal's meter, and hand the asset over if that
 * settles it. Takes only what is still owed; returns what it took so
 * the caller can keep the rest aboard.
 *
 *   { taken: { metal, credits }, settled, voided?, reason?, asset? }
 *   taken is zero when the deal is no longer open.
 */
export async function payIntoDeal(env, gameId, dealId, metal, credits, tick) {
  const deal = await env.DB
    .prepare('SELECT * FROM trade_asset_deals WHERE id = ? AND game_id = ?')
    .bind(dealId, gameId).first();
  const none = { taken: { metal: 0, credits: 0 }, settled: false };
  if (!deal || deal.status !== 'active') return { ...none, reason: 'not_active' };
  const owed = owedOn(deal);
  const takeM = Math.max(0, Math.min(Number(metal) || 0, owed.metal));
  const takeC = Math.max(0, Math.min(Number(credits) || 0, owed.credits));
  if (takeM <= 0 && takeC <= 0) return { ...none, reason: 'nothing_owed' };
  const upd = await env.DB
    .prepare(
      `UPDATE trade_asset_deals SET paid_metal = paid_metal + ?, paid_credits = paid_credits + ?
        WHERE id = ? AND status = 'active'`,
    )
    .bind(takeM, takeC, dealId).run();
  if (!upd.meta?.changes) return { ...none, reason: 'not_active' };
  const taken = { metal: takeM, credits: takeC };
  const after = {
    ...deal,
    paid_metal: Number(deal.paid_metal) + takeM,
    paid_credits: Number(deal.paid_credits) + takeC,
  };
  if (!isSettled(after)) return { taken, settled: false, still_owed: owedOn(after) };

  // PAID IN FULL - hand it over. The asset is re-checked here rather
  // than trusted from the proposal: the seller has had every tick since
  // then to scrap the hull or lose the world.
  const done = await fulfilDeal(env, gameId, after, tick);
  if (!done.ok) {
    const refund = await voidDeal(env, gameId, after, done.reason, tick);
    return { taken, settled: false, voided: true, reason: done.reason, refunded: refund.refunded };
  }
  try {
    await env.DB
      .prepare(
        `INSERT INTO chronicle_entries
          (id, game_id, tick_number, kind, actor_faction_id, body_id, target_faction_id, payload, visibility, created_at_ms)
         VALUES (?, ?, ?, 'asset_sold', ?, ?, ?, ?, 'public', ?)`,
      )
      .bind(
        `asale_${crypto.randomUUID().slice(0, 10)}`, gameId, tick,
        deal.seller_faction_id, deal.delivery_body_id, deal.buyer_faction_id,
        JSON.stringify({
          asset: done.name,
          asset_kind: deal.asset_kind,
          metal: Number(after.paid_metal) || 0,
          credits: Number(after.paid_credits) || 0,
        }),
        Date.now(),
      )
      .run();
  } catch { /* the chronicle is decoration */ }
  return { taken, settled: true, asset: done.name };
}
