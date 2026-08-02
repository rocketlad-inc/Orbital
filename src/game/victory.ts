// ============================================================
// Victory conditions
//
// THREE paths (2026-08-02 rework); whichever fires first wins. The
// checker runs once per tick at the end of advanceToTick. The server
// mirrors this logic in worker/room.js resolveTick so multiplayer
// ends the match at the same instant single-player would.
//
//   ENGINEERING  Build a Dyson Sphere at Sol. The sphere's
//                hit-points are its accumulated resources;
//                completing it (HP = max) wins.
//   CHANCELLOR   The senate elects you Supreme Chancellor — fires
//                from the senate module when a chancellor_vote bill
//                passes (server-authoritative; not evaluated here).
//   DOMINATION   Own MORE than 60% of the map's claimable bodies
//                (everything except stars and black holes — you park
//                a station AROUND Sol, you don't own the sun).
//
// MILITARY (all rival settlements destroyed) was retired in the same
// rework — total elimination now wins by growing into 60% of the map,
// which a sole survivor does uncontested. SCIENCE was removed after
// being flag-disabled (it ended a live game far too cheaply).
// ============================================================

import { GameState, Faction } from '../types';

/** Current victory types plus retired ones ('military'/'science') so
 *  old completed games keep rendering their overlays correctly. */
export type VictoryType =
  | 'engineering' | 'chancellor' | 'domination'
  | 'military' | 'science';

/** Own strictly more than this fraction of claimable bodies to win. */
export const DOMINATION_FRACTION = 0.6;

export interface VictoryResolution {
  winnerFactionId: string;
  victoryType: VictoryType;
  /** Optional human-readable detail surfaced in chronicles / overlay. */
  detail?: string;
}

/** Bodies that count toward domination — everything on the map except
 *  stars and black holes (scenery and hazards, not territory). */
function claimableBodies(state: GameState) {
  return state.bodies.filter(b => b.type !== 'star' && b.type !== 'black_hole');
}

/**
 * Run the per-tick victory check across every faction. Returns the
 * first faction that meets any condition, or null if the game
 * continues. Stops at the first match — by design only one winner
 * per match. (Chancellor never fires here — the senate module ends
 * the game directly when the bill passes.)
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

  // ----- DOMINATION -----
  // Ownership is the settlement-derived Body.ownedBy claim — the same
  // fact the political map shading paints.
  const claimable = claimableBodies(state);
  if (claimable.length > 0) {
    for (const candidate of active) {
      const n = claimable.filter(b => b.ownedBy === candidate.id).length;
      if (n > claimable.length * DOMINATION_FRACTION) {
        return {
          winnerFactionId: candidate.id,
          victoryType: 'domination',
          detail: `Controls ${n} of ${claimable.length} worlds (${Math.round((n / claimable.length) * 100)}%)`,
        };
      }
    }
  }

  return null;
}
