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

/** Mechanically a destroyer that cannot move — SETTLEMENT_SPEED in
 *  worker/factions.js. */
export const SETTLEMENT_COMBAT_SPEED = 0.30;

export type PredictedTarget =
  | { kind: 'ship'; ship: Ship }
  | { kind: 'settlement'; settlement: Settlement };

/** Why a ship isn't going to shoot anything, when it isn't.
 *
 *  'at-peace' and 'defensive-no-aggressor' are the two that look like a
 *  bug from the cockpit: hostiles ARE present and the hull still sits
 *  there. Collapsing them into 'none-present' is what sent a player to
 *  the Discord asking why an attack-stance ship at Enceladus wouldn't
 *  fire. */
export type NoTargetReason =
  | 'hold'
  | 'unarmed'
  | 'in-transit'
  | 'none-present'
  | 'at-peace'
  | 'defensive-no-aggressor';

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
// ---------------------------------------------------------------------
// THE SERVER'S PICK, REPRODUCED EXACTLY.
//
// This module used to choose the nearest target by closing speed while
// the server had moved to a seeded pick held until the target dies. The
// header below has said KEEP IN SYNC the whole time. It only shows
// before a hull's first shot — after that the panel reads the server's
// stamp — but "the prediction is usually wrong" is not a thing a panel
// should quietly be.
//
// Byte-for-byte the same arithmetic as worker/room.js: FNV-1a over the
// id, mixed with the tick, through splitmix32. Any deviation and the two
// disagree on a different subset of ticks, which is worse than an
// obvious mismatch because it looks like it works.
function hashStr(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rollFor(seed: string, atTick: number): number {
  let a = (hashStr(seed) ^ Math.imul(atTick + 1, 2654435761)) >>> 0;
  a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Mirrors pickTarget in worker/room.js: stable id order, hold the last
 *  target while it lives, otherwise a seeded index into the tier. */
function pickWithinTier<T extends { id: string }>(
  attackerId: string, lastTargetId: string | null | undefined,
  tier: T[], atTick: number,
): T | null {
  if (tier.length === 0) return null;
  const sorted = [...tier].sort((x, y) => (x.id < y.id ? -1 : 1));
  if (lastTargetId) {
    const held = sorted.find(t => t.id === lastTargetId);
    if (held) return held;
  }
  const r = rollFor(`${attackerId}:tgt`, atTick);
  return sorted[Math.min(sorted.length - 1, Math.floor(r * sorted.length))];
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
  /** The server's roll is seeded on (attacker id, tick), so predicting
   *  it needs the tick. */
  tick: number;
}): { target?: PredictedTarget; reason?: NoTargetReason } {
  const { attacker, ships, settlements, pactPairs, damagePerTick, tick } = opts;
  if (damagePerTick <= 0) return { reason: 'unarmed' };
  if (attacker.transit) return { reason: 'in-transit' };
  if (attacker.stance === 'hold') return { reason: 'hold' };

  const bodyId = attacker.orbit?.parentBodyId;
  if (!bodyId) return { reason: 'none-present' };

  const foreign = (owner: string) => owner !== attacker.ownedBy;
  const engageable = (owner: string) =>
    foreign(owner) && !atPeace(pactPairs, attacker.ownedBy, owner);

  // DEFENSIVE returns fire only: worker/room.js requires the target's
  // faction to be CURRENTLY AGGRESSING here, meaning it has an armed
  // attack-stance hull parked at this body. Mirror of aggressorsAtBody.
  const aggressors = new Set<string>();
  for (const s of ships) {
    if (s.transit) continue;
    if (s.orbit?.parentBodyId !== bodyId) continue;
    if (!foreign(s.ownedBy)) continue;
    if ((s.damagePerTick ?? 0) <= 0) continue;
    if (s.stance === 'defensive' || s.stance === 'hold') continue;   // attack is the default
    aggressors.add(s.ownedBy);
  }
  const isDefensive = attacker.stance === 'defensive';
  const willEngage = (owner: string) =>
    engageable(owner) && (!isDefensive || aggressors.has(owner));

  // Anyone foreign in this orbit that a treaty is holding us off of —
  // the difference between "nothing here" and "plenty here, all of it
  // under a pact you signed".
  let pactedPresent = false;
  // Foreign and shootable but for our own defensive posture.
  let awaitingAggression = false;

  const armedShips: Ship[] = [];
  const civilianShips: Ship[] = [];
  for (const s of ships) {
    if (s.id === attacker.id) continue;
    if (s.transit) continue;                       // in-transit hulls can't be shot
    if (s.orbit?.parentBodyId !== bodyId) continue;
    if (!foreign(s.ownedBy)) continue;
    if (!engageable(s.ownedBy)) { pactedPresent = true; continue; }
    if (!willEngage(s.ownedBy)) { awaitingAggression = true; continue; }
    ((s.damagePerTick ?? 0) > 0 ? armedShips : civilianShips).push(s);
  }
  const armedStations: Settlement[] = [];
  const softSettlements: Settlement[] = [];
  for (const st of settlements) {
    if (st.bodyId !== bodyId) continue;
    if (!foreign(st.ownedBy)) continue;
    if (!engageable(st.ownedBy)) { pactedPresent = true; continue; }
    if (!willEngage(st.ownedBy)) { awaitingAggression = true; continue; }
    if (st.type === 'station' && (st.buildings?.weapons ?? 0) >= 1) armedStations.push(st);
    else softSettlements.push(st);
  }

  const held = attacker.lastTargetId;

  // Player-set priority reorders the SHIP categories only.
  const priority = attacker.targetPriority;
  if (priority && priority.length > 0) {
    for (const cat of priority as TargetPriorityKey[]) {
      if (cat === 'settlement') continue;          // pinned last
      const pool = cat === 'civilian'
        ? civilianShips
        : cat === 'capital'
          ? armedShips.filter(s => s.class === 'mega_destroyer' || s.class === 'mobile_foundry')
          : armedShips.filter(s => s.class === cat);
      const hit = pickWithinTier(attacker.id, held, pool, tick);
      if (hit) return { target: { kind: 'ship', ship: hit } };
    }
  }

  // Ladder (also the fallback when a ranked list matches nothing).
  const shipTier = armedShips.length ? armedShips : civilianShips;
  const shipHit = pickWithinTier(attacker.id, held, shipTier, tick);
  if (shipHit) return { target: { kind: 'ship', ship: shipHit } };

  const stlTier = armedStations.length ? armedStations : softSettlements;
  const stlHit = pickWithinTier(attacker.id, held, stlTier, tick);
  if (stlHit) return { target: { kind: 'settlement', settlement: stlHit } };

  // Ranked most specific first: a pact is the actionable fact, and the
  // player can break one. Defensive posture is the next thing they can
  // change. Only then is the orbit genuinely empty of targets.
  if (pactedPresent) return { reason: 'at-peace' };
  if (awaitingAggression) return { reason: 'defensive-no-aggressor' };
  return { reason: 'none-present' };
}
