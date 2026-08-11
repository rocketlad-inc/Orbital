import { getActiveSliders } from './senate.js';

// ============================================================
// Ship build price — the ONE place the multiplier chain lives.
//
// Three independent dials scale what a hull costs, and they used to be
// copy-pasted into the queue path and the rush path in actions.js while
// the client's build menu quoted the unscaled base price from
// src/game/shipClasses.ts. That meant a passed
// `ship_build_cost_multiplier` law genuinely halved what players were
// charged and the menu still displayed full price, so the senate's one
// economic lever looked broken to everyone who voted for it.
//
// The copies had already drifted: the queue applied the host's
// ship_cost_mult config dial, rush did not, so on any game where the host
// moved that dial rushing was priced off a different base than building.
// One helper, three callers, no drift.
// ============================================================

/** Construction tech: −5%/level, floored. Mirrors buildCostModifier in
 *  src/game/techs.ts, which SP applies in buildShip. */
const CONSTRUCTION_PER_LEVEL = 0.05;
const CONSTRUCTION_FLOOR = 0.25;

/**
 * Every factor scaling ship prices for one faction right now, returned
 * SEPARATELY rather than pre-multiplied.
 *
 * The UI needs the breakdown, not just the product: "128M" tells a player
 * nothing, "128M (was 256M — Shipbuilding Subsidy)" tells them the bill
 * they voted for is working. `mult` is the product for callers that only
 * want to charge.
 *
 * Every lookup is individually try//catch'd and falls back to 1. A price
 * quote must never be the thing that 500s a build request — but note the
 * failure mode is charging FULL price, which is the safe direction: a
 * silent 1.0 overcharges rather than handing out free ships.
 *
 * `rush` is the senate's separate rush knob. It is NOT folded into
 * `mult`, because it applies to exactly one action; rushers multiply it
 * in themselves.
 */
export async function buildCostFactors(env, gameId, factionId, currentTick) {
  const out = {
    config: 1,
    law: 1,
    tech: 1,
    rush: 1,
    construction_level: 0,
    mult: 1,
  };

  try {
    const gc = await import('./gameConfig.js');
    const conf = await gc.cfg(env, gameId);
    const m = Number(conf.ship_cost_mult);
    if (Number.isFinite(m) && m > 0) out.config = m;
  } catch { /* shipped price */ }

  try {
    // Per-faction: a law aimed at this faction overrides the general one.
    const sliders = await getActiveSliders(env, gameId, currentTick, factionId);
    const v = Number(sliders.ship_build_cost_multiplier);
    if (Number.isFinite(v) && v > 0) out.law = v;
    const r = Number(sliders.rush_cost_multiplier);
    if (Number.isFinite(r) && r > 0) out.rush = r;
  } catch { /* no active law */ }

  try {
    const ct = await env.DB
      .prepare("SELECT level FROM faction_techs WHERE game_id = ? AND faction_id = ? AND tech_id = 'construction'")
      .bind(gameId, factionId)
      .first();
    const lvl = Number(ct?.level ?? 0);
    out.construction_level = lvl;
    out.tech = Math.max(CONSTRUCTION_FLOOR, 1 - CONSTRUCTION_PER_LEVEL * lvl);
  } catch { /* no discount */ }

  // Config dial FIRST conceptually: the law and the tech discount are
  // relative modifiers on whatever base price the host has set.
  out.mult = out.config * out.law * out.tech;
  return out;
}
