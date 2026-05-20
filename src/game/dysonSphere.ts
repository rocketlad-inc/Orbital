// ============================================================
// Dyson Sphere — engineering megaproject at Sol.
//
// One sphere per match. The faction that lays the foundation
// (initiateDysonSphere on one of their Sol-orbit stations) becomes
// the controller. Per tick, every parked freighter the controller
// owns at Sol drains a fixed quota from the controller's empire
// pool and adds it to the sphere's progress. Progress IS the
// sphere's hit-points; combat damage reduces HP and proportionally
// scales the accumulated resources back down.
//
// When HP reaches maxHp, Engineering Victory fires (see
// src/game/victory.ts). When HP reaches 0, the sphere collapses
// and the foundation slot reopens for the next builder.
//
// Server mirror: worker/room.js resolveTick handles all of this
// against the games row's dyson_* columns. Keep the rules below
// in sync with that file.
// ============================================================

import { DysonSphereState, Settlement, Ship, FactionResources } from '../types';

/** ID used to identify Sol so we don't repeat the string literal. */
export const SOL_BODY_ID = 'sol';

/**
 * Target totals for a completed Dyson Sphere. Sum across all four
 * is the sphere's maxHp. Tuned so a focused empire with 5+ parked
 * freighters at Sol can complete it in ~600 game-ticks (~3 real days
 * at the 7.5-min cadence), which is most of a 3-week match.
 *
 * Roughly:
 *   maxHp = 15_000 + 15_000 + 10_000 + 10_000 = 50_000
 *   Per freighter per tick contribution = 30 (sum of all 4 deltas)
 *   5 freighters → 150/tick → 50000/150 ≈ 333 ticks (~1.7 real days)
 *   10 freighters → 300/tick → 167 ticks (~0.9 real days)
 *
 * Bumping a freighter into Sol orbit costs fuel and ties it up for
 * the entire build — real opportunity cost, plus you have to fund
 * the constant pool drain from your wider economy.
 */
export const DYSON_TARGET: { fuel: number; ore: number; credits: number; science: number } = {
  fuel: 10_000,
  ore: 15_000,
  credits: 15_000,
  science: 10_000,
};

/** Per-freighter per-tick contribution toward the sphere. The owner's
 *  pool is debited by these amounts each tick for every freighter
 *  parked at Sol. Sum = 30. */
export const DYSON_PER_FREIGHTER_PER_TICK = {
  fuel: 5,
  ore: 10,
  credits: 10,
  science: 5,
} as const;

/** Total maxHp = sum of target across all four resources. Cached so
 *  every render doesn't re-add. */
export const DYSON_MAX_HP =
  DYSON_TARGET.fuel + DYSON_TARGET.ore + DYSON_TARGET.credits + DYSON_TARGET.science;

/** Helper — build a fresh DysonSphereState owned by `factionId` with
 *  `foundationSettlementId` as the foundation. Accumulated starts at
 *  zero across the board; HP starts at zero (= "shell is laid but
 *  empty"). The caller is responsible for debiting whatever
 *  one-time cost the foundation imposes (currently zero — the cost
 *  is entirely in the per-tick freighter drain). */
export function createDysonSphere(
  factionId: string,
  foundationSettlementId: string,
  tick: number,
): DysonSphereState {
  return {
    controllerFactionId: factionId,
    foundationSettlementId,
    accumulated: { fuel: 0, ore: 0, credits: 0, science: 0 },
    target: { ...DYSON_TARGET },
    hp: 0,
    maxHp: DYSON_MAX_HP,
    startedAtTick: tick,
  };
}

/** Run one tick of Dyson Sphere delivery. Returns the updated state
 *  + the debit that should be applied to the controller's resource
 *  pool. Returns null patches when there are no freighters at Sol
 *  or the controller has no pool entry. */
export interface DysonTickResult {
  next: DysonSphereState;
  poolDebit: { fuel: number; ore: number; credits: number; science: number };
  freighterCount: number;
  contributionThisTick: number;
}

export function tickDysonDelivery(
  state: DysonSphereState,
  ships: Ship[],
  pool: FactionResources | undefined,
): DysonTickResult {
  // Count the controller's freighters parked at Sol — not in transit,
  // not in mid-burn. Each contributes a flat quota per tick (capped
  // by what's actually in the pool — never debit into the negatives).
  const freighters = ships.filter(s =>
    s.ownedBy === state.controllerFactionId &&
    s.class === 'freighter' &&
    !s.transit &&
    s.orbit.parentBodyId === SOL_BODY_ID,
  );
  const n = freighters.length;
  if (n === 0 || !pool) {
    return {
      next: state,
      poolDebit: { fuel: 0, ore: 0, credits: 0, science: 0 },
      freighterCount: 0,
      contributionThisTick: 0,
    };
  }

  // Per-resource desired contribution. Clamp by pool availability and
  // by remaining target (don't over-fill a resource that's already
  // at its target).
  const want = {
    fuel:    DYSON_PER_FREIGHTER_PER_TICK.fuel    * n,
    ore:     DYSON_PER_FREIGHTER_PER_TICK.ore     * n,
    credits: DYSON_PER_FREIGHTER_PER_TICK.credits * n,
    science: DYSON_PER_FREIGHTER_PER_TICK.science * n,
  };
  const move = {
    fuel:    Math.max(0, Math.min(want.fuel,    pool.fuel,    state.target.fuel    - state.accumulated.fuel)),
    ore:     Math.max(0, Math.min(want.ore,     pool.ore,     state.target.ore     - state.accumulated.ore)),
    credits: Math.max(0, Math.min(want.credits, pool.credits, state.target.credits - state.accumulated.credits)),
    science: Math.max(0, Math.min(want.science, pool.science, state.target.science - state.accumulated.science)),
  };
  const contribution = move.fuel + move.ore + move.credits + move.science;
  if (contribution === 0) {
    return {
      next: state,
      poolDebit: { fuel: 0, ore: 0, credits: 0, science: 0 },
      freighterCount: n,
      contributionThisTick: 0,
    };
  }

  const next: DysonSphereState = {
    ...state,
    accumulated: {
      fuel:    state.accumulated.fuel    + move.fuel,
      ore:     state.accumulated.ore     + move.ore,
      credits: state.accumulated.credits + move.credits,
      science: state.accumulated.science + move.science,
    },
    hp: Math.min(state.maxHp, state.hp + contribution),
  };

  return { next, poolDebit: move, freighterCount: n, contributionThisTick: contribution };
}

/** Apply combat damage. The damage value comes from whatever shot
 *  the sphere (currently routed through the foundation station's
 *  damage events — see room.js). Damage reduces HP first; the
 *  proportional ratio is then applied to all four accumulated
 *  resources so the sphere always reads as a coherent "X% built".
 *  If HP hits zero, the sphere collapses (returns null). */
export function damageDysonSphere(
  state: DysonSphereState,
  damage: number,
): DysonSphereState | null {
  if (damage <= 0) return state;
  const newHp = state.hp - damage;
  if (newHp <= 0) return null;
  // Preserve the build's coherence: at 30% HP loss, every resource
  // bucket also reads 30% lower. Otherwise damage would let players
  // game completion by tanking ore but rebuilding credits.
  const ratio = newHp / state.hp;
  return {
    ...state,
    hp: newHp,
    accumulated: {
      fuel:    state.accumulated.fuel    * ratio,
      ore:     state.accumulated.ore     * ratio,
      credits: state.accumulated.credits * ratio,
      science: state.accumulated.science * ratio,
    },
  };
}

/** A Sol-orbit station that COULD become a Dyson Sphere foundation:
 *  must be a station, must orbit Sol, must be the caller's. The first
 *  station to call initiateDysonSphere wins the foundation slot for
 *  the match. */
export function isEligibleDysonFoundation(
  s: Settlement,
  factionId: string,
): boolean {
  return s.type === 'station' && s.bodyId === SOL_BODY_ID && s.ownedBy === factionId;
}
