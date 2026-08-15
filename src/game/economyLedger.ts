// ============================================================
// economyLedger — what you earn, what your fleet bills, per currency.
//
// One computation, two readers: the Economy sheet renders it, and the
// Situation Report warns off it. That is the point. The billing rule is
// subtle (see below), it already existed twice — once in the tick and
// once in the panel — and a third copy written for the warning would be
// a third thing to drift. A sitrep that disagrees with the sheet it
// tells you to open is worse than no sitrep.
//
// THE RULE WORTH UNDERSTANDING. A hull's upkeep TOTAL comes from its
// class, but which pocket it comes out of depends on what the ship is
// made of: kinetic and shield parts pull metal 8:1, energy and armour
// pull credits 1:8 (upkeepSplitFor, mirroring worker/shipDesigns.js).
// So the axis that governs what a ship costs to BUILD also governs what
// it costs to KEEP.
//
// WHY THAT MATTERS ENOUGH TO WARN ABOUT. Arrears is tracked PER
// CURRENCY on the server — arrears_metal and arrears_gold are separate
// columns and the −25% fleet damage penalty fires if EITHER is above
// zero. So an empire with healthy total income can still be crippled
// because its designs bill a pocket its worlds do not fill. Nothing in
// the game says so until the penalty lands, which is what this exists
// to fix.
// ============================================================

import type { GameState } from '../types';
import { settlementYield, NO_COLLECTOR_POOL_FRACTION } from './settlements';
import { SHIP_UPKEEP, upkeepSplitFor, type ShipClassName } from './shipClasses';
import { TECH_DEFS } from './techs';
import { partsCost, sanitizeParts } from './shipParts';

export type Currency = 'metal' | 'credits';

export interface CurrencyLine {
  /** Reaching the pool each tick, after the raw-world haircut. */
  income: number;
  /** Billed by the fleet each tick, at current laws. */
  upkeep: number;
  /** income − upkeep. Negative means the stockpile is draining. */
  net: number;
  /** What is banked right now. */
  stock: number;
  /** Ticks until the stockpile hits zero at the current net, or null
   *  when not draining (nothing to count down to). */
  runway: number | null;
}

export interface EconomyLedger {
  metal: CurrencyLine;
  credits: CurrencyLine;
  /** Share of fleet upkeep billed to metal, 0..1. The composition
   *  number a player can act on: high means kinetic/shield-heavy. */
  metalShare: number;
  /** Hulls counted. Zero means every figure above is trivially 0. */
  hulls: number;
}

const line = (income: number, upkeep: number, stock: number): CurrencyLine => {
  const net = income - upkeep;
  return {
    income,
    upkeep,
    net,
    stock,
    // Only a DRAIN has a runway. A surplus counting down to zero would
    // be a nonsense number, and a zero-net line would divide to Infinity.
    runway: net < -1e-9 ? Math.max(0, stock / -net) : null,
  };
};

/** Per-tick ledger for the player. Pure — takes state, returns numbers,
 *  so the sitrep, the panel and a test can all ask the same question. */
export function economyLedger(gameState: GameState): EconomyLedger {
  // ---- income: the same multipliers the tick applies -----------------
  const lvl = gameState.factionTech?.player?.levels?.industry ?? 0;
  const yieldMul = 1 + TECH_DEFS.industry.perLevel * lvl;
  const sl = gameState.activeSliders;
  const sMetal = sl?.metalYieldMultiplier ?? 1;
  const sCredits = sl?.goldYieldMultiplier ?? 1;

  let incMetal = 0;
  let incCredits = 0;
  for (const s of gameState.settlements) {
    if (s.ownedBy !== 'player') continue;
    const body = gameState.bodies.find(b => b.id === s.bodyId);
    const y = body ? settlementYield(s, body) : { fuel: 0, ore: 0, credits: 0, science: 0 };
    // A raw world banks most of its yield on-site and trickles the rest
    // home; a terraformed one ships everything. MP keys this on the
    // BODY; SP leaves the field undefined and keeps the collector rule.
    const docked = body && body.terraformedAtTick !== undefined
      ? body.terraformedAtTick !== null
      : !!s.hasCollector;
    const f = docked ? 1 : NO_COLLECTOR_POOL_FRACTION;
    incMetal += y.ore * yieldMul * sMetal * f;
    incCredits += y.credits * yieldMul * sCredits * f;
  }

  // ---- upkeep: per hull, by loadout ---------------------------------
  const upkeepMul = sl?.fleetUpkeepMultiplier ?? 1;
  let upMetal = 0;
  let upCredits = 0;
  let hulls = 0;
  for (const s of gameState.ships) {
    if (s.ownedBy !== 'player') continue;
    const cls = s.class as ShipClassName;
    if (!SHIP_UPKEEP[cls]) continue;
    const up = upkeepSplitFor(cls, sanitizeParts(s.parts ?? []), partsCost);
    upMetal += up.ore * upkeepMul;
    upCredits += up.credits * upkeepMul;
    hulls += 1;
  }

  const pool = gameState.resources?.player;
  const totalUp = upMetal + upCredits;

  return {
    metal: line(incMetal, upMetal, pool?.ore ?? 0),
    credits: line(incCredits, upCredits, pool?.credits ?? 0),
    metalShare: totalUp > 0 ? upMetal / totalUp : 0,
    hulls,
  };
}

// ---------------------------------------------------------------
// The warning thresholds, here rather than in the hook so the test and
// the UI cannot disagree about when this fires.
// ---------------------------------------------------------------

/** Below this, a deficit is rounding error on a small empire and
 *  warning about it is noise. Two corvettes at turn one must not
 *  produce a sitrep item. */
export const MIX_MIN_UPKEEP = 2;

/** Stockpile deep enough that the drain is somebody's problem for
 *  another day. Beyond this the item is not worth a slot. */
export const MIX_MAX_RUNWAY = 40;

/** Inside this, the arrears penalty is close enough to be urgent. */
export const MIX_URGENT_RUNWAY = 15;

export interface MixWarning {
  currency: Currency;
  line: CurrencyLine;
  urgent: boolean;
}

/** Currencies whose fleet bill outruns their income, worth telling the
 *  player about. Ordered most urgent first. Empty is the normal case. */
export function upkeepMixWarnings(led: EconomyLedger): MixWarning[] {
  const out: MixWarning[] = [];
  for (const currency of ['metal', 'credits'] as Currency[]) {
    const l = led[currency];
    if (l.net >= 0) continue;                       // paying its way
    if (l.upkeep < MIX_MIN_UPKEEP) continue;        // too small to matter
    if (l.runway == null || l.runway > MIX_MAX_RUNWAY) continue;  // plenty banked
    out.push({ currency, line: l, urgent: l.runway <= MIX_URGENT_RUNWAY });
  }
  return out.sort((a, b) => (a.line.runway ?? 0) - (b.line.runway ?? 0));
}
