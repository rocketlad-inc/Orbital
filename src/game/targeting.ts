// ============================================================
// targeting — who a hull will shoot NEXT.
//
// The server stamps last_target_id only when a ship actually FIRES, so a
// hull that just arrived in a brawl has no stamped target and the ship
// card had nothing to say — during a battle, which reads as broken
// ("my corvettes have entered the fray, but they don't have a target?").
//
// This mirrors the target-selection block in worker/room.js so the card
// can answer the question before the first volley. It is a PREDICTION:
// the server re-picks every tick against state that may have moved, and
// this deliberately does not model the defensive-stance aggressor gate
// (which needs who-attacked-whom history the client doesn't keep).
//
// KEEP IN SYNC with worker/room.js — the tier ladder, the settlements
// pin, and the nearest-speed-then-slower tie-break all live there too.
// ============================================================

import { Ship, Settlement, TargetPriorityKey } from '../types';
import { makePeaceCheck } from './peace';
import { ShipClassName } from './shipClasses';
import { combatSpeedOf } from './shipParts';

/** Mechanically a destroyer that cannot move — SETTLEMENT_SPEED in
 *  worker/factions.js. */
export const SETTLEMENT_COMBAT_SPEED = 0.30;

export type PredictedTarget =
  | { kind: 'ship'; ship: Ship }
  | { kind: 'settlement'; settlement: Settlement };

/** Why a ship isn't going to shoot anything, when it isn't. */
export type NoTargetReason = 'hold' | 'unarmed' | 'in-transit' | 'none-present';

// Was a local pair-key + Array.includes. The key-ordering rule lived in
// three files; makePeaceCheck is the one copy, and it hashes the pairs
// once instead of scanning the array per candidate.
function atPeace(pactPairs: string[] | undefined, a: string, b: string): boolean {
  return makePeaceCheck(pactPairs)(a, b);
}

/**
 * Nearest speed wins; on an EQUAL gap the SLOWER candidate wins (close,
 * then below, then above). Ties beyond that break on id so every client
 * predicts what the server picks.
 */
function nearestBySpeed<T extends { id: string }>(
  candidates: T[],
  atkSpeed: number,
  speedOf: (c: T) => number,
): T | undefined {
  if (candidates.length === 0) return undefined;
  const sorted = [...candidates].sort((a, b) => (a.id < b.id ? -1 : 1));
  let best = sorted[0];
  let bestGap = Infinity;
  let bestBelow = false;
  for (const c of sorted) {
    const gap = Math.abs(atkSpeed - speedOf(c));
    const below = speedOf(c) <= atkSpeed;
    if (gap < bestGap - 1e-9 || (Math.abs(gap - bestGap) <= 1e-9 && below && !bestBelow)) {
      bestGap = gap; bestBelow = below; best = c;
    }
  }
  return best;
}

/**
 * Who `attacker` would engage right now, or why it wouldn't.
 *
 * Mirrors the ladder: armed hostile ships, then civilians, then armed
 * stations, then everything else — with a player-set priority reordering
 * only the SHIP categories, because settlements are pinned last
 * (worker/room.js skips the settlement entry wherever it sits).
 */
export function predictTarget(opts: {
  attacker: Ship;
  ships: Ship[];
  settlements: Settlement[];
  pactPairs?: string[];
  /** Damage the attacker deals; 0 means it never engages. */
  damagePerTick: number;
}): { target?: PredictedTarget; reason?: NoTargetReason } {
  const { attacker, ships, settlements, pactPairs, damagePerTick } = opts;
  if (damagePerTick <= 0) return { reason: 'unarmed' };
  if (attacker.transit) return { reason: 'in-transit' };
  if (attacker.stance === 'hold') return { reason: 'hold' };

  const bodyId = attacker.orbit?.parentBodyId;
  if (!bodyId) return { reason: 'none-present' };

  const engageable = (owner: string) =>
    owner !== attacker.ownedBy && !atPeace(pactPairs, attacker.ownedBy, owner);

  const armedShips: Ship[] = [];
  const civilianShips: Ship[] = [];
  for (const s of ships) {
    if (s.id === attacker.id) continue;
    if (s.transit) continue;                       // in-transit hulls can't be shot
    if (s.orbit?.parentBodyId !== bodyId) continue;
    if (!engageable(s.ownedBy)) continue;
    ((s.damagePerTick ?? 0) > 0 ? armedShips : civilianShips).push(s);
  }
  const armedStations: Settlement[] = [];
  const softSettlements: Settlement[] = [];
  for (const st of settlements) {
    if (st.bodyId !== bodyId) continue;
    if (!engageable(st.ownedBy)) continue;
    if (st.type === 'station' && (st.buildings?.weapons ?? 0) >= 1) armedStations.push(st);
    else softSettlements.push(st);
  }

  const atkSpeed = combatSpeedOf(attacker.class as ShipClassName, attacker.parts);
  const shipSpeed = (s: Ship) => combatSpeedOf(s.class as ShipClassName, s.parts);

  // Player-set priority reorders the SHIP categories only.
  const priority = attacker.targetPriority;
  if (priority && priority.length > 0) {
    for (const cat of priority as TargetPriorityKey[]) {
      if (cat === 'settlement') continue;          // pinned last
      const pool = cat === 'civilian'
        ? civilianShips
        : armedShips.filter(s => s.class === cat);
      const hit = nearestBySpeed(pool, atkSpeed, shipSpeed);
      if (hit) return { target: { kind: 'ship', ship: hit } };
    }
  }

  // Ladder (also the fallback when a ranked list matches nothing).
  const shipTier = armedShips.length ? armedShips : civilianShips;
  const shipHit = nearestBySpeed(shipTier, atkSpeed, shipSpeed);
  if (shipHit) return { target: { kind: 'ship', ship: shipHit } };

  const stlTier = armedStations.length ? armedStations : softSettlements;
  const stlHit = nearestBySpeed(stlTier, atkSpeed, () => SETTLEMENT_COMBAT_SPEED);
  if (stlHit) return { target: { kind: 'settlement', settlement: stlHit } };

  return { reason: 'none-present' };
}
