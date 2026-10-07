// ============================================================
// THE LEG GUARD — a hull can only fly as fast as its engines allow.
//
// Every leg's plan is computed by the CLIENT (torchTransfer.ts) and the
// server stored it as given: the push, its build-up, its cap, the brake,
// and the arrival tick. That was harmless while every trip was short.
// With the far systems (and the burn capped at 0.1g, burn.js) the game
// becomes a race across interstellar space, and a modified client that
// claimed a 1g push, or simply an arrival next tick, would win every
// race. So before a leg is stored the server asks two questions:
//
//   1. Are the burn's numbers within this hull's limits? Its launch push
//      is the floor (burn.js SHIP_ENGINE_G) times its engine parts
//      (shipParts.ts engineAccelMultiplier, at the owner's Propulsion
//      level) times a Voidrunner captain's 1.1; the build may not grow
//      faster than GROWTH_TAU, top out above the cap times that, or
//      brake harder than BRAKE_MUL times what it reached.
//   2. Is the arrival no sooner than the fastest legal trip over the
//      straight line from launch to where the target will be? (burn.js
//      legTicks, the function every server leg timer uses.)
//
// A legitimate client plans EXACTLY at its limits, never past them, so
// the slack is generous (2% on the numbers; 10% plus one tick on the
// time) and is there for float and rounding only. scripts/check-leg-
// guard.mjs replays every stored leg through this before it is trusted.
// ============================================================

import {
  SHIP_ENGINE_ACCEL, MAX_ENGINE_G, SHIP_ENGINE_G, GROWTH_TAU, BRAKE_MUL, legTicks,
} from './burn.js';

// MIRRORS src/game/shipParts.ts (ENGINE_TRAVEL_PCT, PROPULSION_TECH_PER_LVL,
// engineTravelMultiplier, engineAccelMultiplier). legGuard.test holds the
// two to each other.
const ENGINE_TRAVEL_PCT = 0.15;
const PROPULSION_TECH_PER_LVL = 0.06;
/** The Voidrunner trait (worker/captains.js): +10% engine acceleration. */
const VOIDRUNNER_ACCEL_MUL = 1.10;

const NUM_SLACK = 1.02;
const TIME_SLACK = 0.9;
const TIME_SLACK_TICKS = 1;

/** Engine parts' acceleration multiplier, as the client computes it. */
export function engineAccelMul(parts, propulsionLvl = 0) {
  const n = (Array.isArray(parts) ? parts : []).filter(p => p === 'engine').length;
  if (n <= 0) return 1;
  const perEngine = Math.min(0.9, ENGINE_TRAVEL_PCT * (1 + PROPULSION_TECH_PER_LVL * Math.max(0, propulsionLvl)));
  const m = Math.max(0.1, Math.pow(1 - perEngine, n));
  return 1 / (m * m);
}

/** The most a hull can push at launch, game units / tick^2. */
export function maxLaunchAccel({ parts, propulsionLvl = 0, traits = [] }) {
  const captain = (Array.isArray(traits) ? traits : []).includes('voidrunner') ? VOIDRUNNER_ACCEL_MUL : 1;
  return SHIP_ENGINE_ACCEL * engineAccelMul(parts, propulsionLvl) * captain;
}

/**
 * Why a leg is refused, or null if it is within the hull's limits.
 *   a0max    maxLaunchAccel for the hull
 *   plan     parseTransferBody's plan (acc, amax, atau, rmp, brk) or null
 *   depart   scheduled_t; arrive: arrival_t
 *   distance straight line, launch point to target at arrival (null skips
 *            the timing check, e.g. a rendezvous)
 */
export function legRefusal({ a0max, plan, depart, arrive, distance }) {
  if (!(a0max > 0)) return null;
  const topMax = a0max * (MAX_ENGINE_G / SHIP_ENGINE_G);
  if (plan) {
    if (plan.acc > a0max * NUM_SLACK) return 'push';
    if (plan.amax != null && plan.amax > topMax * NUM_SLACK) return 'cap';
    if (plan.atau != null && plan.atau < GROWTH_TAU / NUM_SLACK) return 'build';
    if (plan.rmp != null && plan.amax == null) return 'build';
    const reached = Math.max(plan.acc, plan.amax ?? plan.acc);
    if (plan.brk != null && plan.brk > BRAKE_MUL * reached * NUM_SLACK) return 'brake';
  }
  if (distance != null && Number.isFinite(distance) && arrive != null && Number.isFinite(arrive)) {
    const legal = legTicks(Math.max(0.01, distance), a0max);
    if (arrive - depart < legal * TIME_SLACK - TIME_SLACK_TICKS) return 'too_soon';
  }
  return null;
}

/** The player-facing words for a refusal. */
export const LEG_REFUSAL_MESSAGE = {
  push: 'that burn pushes harder than this hull’s engines can',
  cap: 'that burn tops out faster than this hull’s engines allow',
  build: 'that burn builds up faster than any engine can',
  brake: 'that burn brakes harder than this hull can',
  too_soon: 'that arrival is sooner than this hull can fly the distance',
};

/** Hull limits for a set of ships in one game: { shipId -> a0max }. */
export async function hullLimits(DB, gameId, shipIds) {
  const out = new Map();
  if (!shipIds.length) return out;
  const ids = [...new Set(shipIds)];
  const rows = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const ph = chunk.map(() => '?').join(',');
    rows.push(...((await DB.prepare(
      `SELECT s.id, s.owner_faction_id, s.parts_json, c.traits_json
         FROM game_ships s LEFT JOIN game_captains c ON c.id = s.captain_id
        WHERE s.game_id = ? AND s.id IN (${ph})`,
    ).bind(gameId, ...chunk).all()).results ?? []));
  }
  const factionIds = [...new Set(rows.map(r => r.owner_faction_id).filter(Boolean))];
  const prop = new Map();
  if (factionIds.length) {
    const ph = factionIds.map(() => '?').join(',');
    for (const r of (await DB.prepare(
      `SELECT faction_id, level FROM faction_techs
        WHERE game_id = ? AND tech_id = 'propulsion' AND faction_id IN (${ph})`,
    ).bind(gameId, ...factionIds).all()).results ?? []) prop.set(r.faction_id, Number(r.level) || 0);
  }
  const parse = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };
  for (const r of rows) {
    out.set(r.id, maxLaunchAccel({
      parts: parse(r.parts_json), propulsionLvl: prop.get(r.owner_faction_id) ?? 0, traits: parse(r.traits_json),
    }));
  }
  return out;
}
