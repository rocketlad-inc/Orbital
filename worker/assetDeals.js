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
