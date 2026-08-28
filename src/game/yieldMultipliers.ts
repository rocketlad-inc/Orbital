// ============================================================
// Empire yield multipliers — the multipliers the TICK applies on top of
// a settlement's own output.
//
// settlementYield() answers "what does this settlement produce",
// folding in population, type, and its own buildings. It deliberately
// stops there. Two more multipliers land before the resource reaches
// you, and they are empire-wide rather than per-settlement:
//
//   * the Industry tech bonus (+10% per level, every resource), and
//   * the Senate yield sliders (per resource, so a passed "Faster
//     Research" law doubles science and nothing else).
//
// This existed twice — once in EconomyPanel, once in economyLedger —
// and NOT AT ALL in the three readouts that quote a single body:
// the world menu, the body inspector, and the settlements panel. So a
// player with Industry 2 and a science law read "6.6S" on Mars while
// the Economy tab said 15.84S, and both were describing the same world.
// One copy, used by every readout.
// ============================================================

import { TECH_DEFS } from './techs';
import { GameState } from '../types';

export interface YieldMultipliers {
  fuel: number;
  ore: number;
  credits: number;
  science: number;
}

export const NEUTRAL_YIELD: YieldMultipliers = {
  fuel: 1, ore: 1, credits: 1, science: 1,
};

/**
 * The multipliers in force for the viewing player, from tech levels and
 * standing Senate law. Neutral (all 1) when neither applies, so SP and
 * pre-Senate games read exactly as before.
 */
export function empireYieldMultipliers(gameState: GameState): YieldMultipliers {
  const lvl = gameState.factionTech?.player?.levels?.industry ?? 0;
  const industry = 1 + TECH_DEFS.industry.perLevel * lvl;
  const sl = gameState.activeSliders;
  return {
    // Fuel has no slider of its own; it still rides the Industry bonus.
    fuel: industry,
    ore: industry * (sl?.metalYieldMultiplier ?? 1),
    credits: industry * (sl?.goldYieldMultiplier ?? 1),
    science: industry * (sl?.scienceYieldMultiplier ?? 1),
  };
}

/** Apply the multipliers to one settlement's raw output. */
export function applyYieldMultipliers<T extends {
  fuel?: number; ore?: number; credits?: number; science?: number;
}>(raw: T, m: YieldMultipliers): {
  fuel: number; ore: number; credits: number; science: number;
} {
  return {
    fuel: (raw.fuel ?? 0) * m.fuel,
    ore: (raw.ore ?? 0) * m.ore,
    credits: (raw.credits ?? 0) * m.credits,
    science: (raw.science ?? 0) * m.science,
  };
}
