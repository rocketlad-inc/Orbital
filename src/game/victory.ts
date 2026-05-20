// ============================================================
// Victory conditions
//
// Three independent paths; whichever fires first wins. The
// checker runs once per tick at the end of advanceToTick. The
// server mirrors this logic in worker/room.js resolveTick so
// multiplayer ends the match at the same instant single-player
// would.
//
//   ENGINEERING  Build a Dyson Sphere at Sol. The sphere's
//                hit-points are its accumulated resources;
//                completing it (HP = max) wins.
//   MILITARY     Every other faction has zero settlements
//                (cities and stations both count toward
//                elimination — per the player's spec).
//   SCIENCE      Every tech track at TECH_MAX_LEVEL.
//
// ============================================================

import { GameState, Faction } from '../types';
import { allTechsMaxed } from './techs';

/** New victory types added in the three-conditions PR.
 *  Older labels (hegemony/wealth/tiebreak) still compile in the
 *  VictoryOverlay's label table for back-compat with replays. */
export type VictoryType = 'engineering' | 'military' | 'science';

export interface VictoryResolution {
  winnerFactionId: string;
  victoryType: VictoryType;
  /** Optional human-readable detail surfaced in chronicles / overlay. */
  detail?: string;
}

/**
 * Run the per-tick victory check across every faction. Returns the
 * first faction that meets any condition, or null if the game
 * continues. Stops at the first match — by design only one
 * winner per match.
 *
 * Order of evaluation: engineering → military → science. Engineering
 * is a one-shot, military requires elimination which is a strong
 * signal, science is the long-tail.
 */
export function checkVictory(state: GameState): VictoryResolution | null {
  // Eligible factions — exclude observers and eliminated seats so
  // the overlay never declares a winner that's no longer in the game.
  const active: Faction[] = state.factions.filter(f => {
    // Default to active when no explicit status; SP factions don't
    // carry a status field, MP ones might via remap.
    const status = (f as any).status;
    return status == null || status === 'active';
  });

  // ----- ENGINEERING -----
  // The dysonSphere object lives on GameState. If progress is full
  // and the controller still owns the foundation station, they win.
  // (Station destruction nukes the sphere — see settlements.ts
  // collapseDysonOnStationLoss — so the controller check at win
  // time is belt-and-suspenders.)
  const dyson = state.dysonSphere;
  if (dyson && dyson.controllerFactionId && dyson.hp >= dyson.maxHp && dyson.maxHp > 0) {
    return {
      winnerFactionId: dyson.controllerFactionId,
      victoryType: 'engineering',
      detail: 'Dyson Sphere complete',
    };
  }

  // ----- MILITARY -----
  // For each candidate, count rivals that still have at least one
  // settlement (city OR station). If none remain, candidate wins.
  for (const candidate of active) {
    const rivals = active.filter(f => f.id !== candidate.id);
    if (rivals.length === 0) continue; // 1-faction game = no military win possible
    const anyRivalAlive = rivals.some(r =>
      state.settlements.some(s => s.ownedBy === r.id),
    );
    if (!anyRivalAlive) {
      return {
        winnerFactionId: candidate.id,
        victoryType: 'military',
        detail: 'All rival settlements destroyed',
      };
    }
  }

  // ----- SCIENCE -----
  // Any faction with every tech track at TECH_MAX_LEVEL wins.
  // FactionTechStateBase (in types.ts) and FactionTechState (in techs.ts)
  // are structurally identical for the level-counter use case here, but
  // TypeScript can't widen the `researching` field's string type to
  // TechId implicitly. Cast through unknown — values are equivalent
  // for the read-only level lookups allTechsMaxed performs.
  for (const candidate of active) {
    const techState = state.factionTech?.[candidate.id] as unknown as
      Parameters<typeof allTechsMaxed>[0];
    if (allTechsMaxed(techState)) {
      return {
        winnerFactionId: candidate.id,
        victoryType: 'science',
        detail: 'All tech tracks mastered',
      };
    }
  }

  return null;
}
