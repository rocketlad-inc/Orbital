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
//   DOMINATION   Own MORE than 60% of the worlds that can hold a
//                station — which is every body on the map (stations
//                have no body-type gate; even Sol is territory).
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

/** Bodies that count toward domination — every world that can hold a
 *  station, which is EVERY body on the map (stations have no body-type
 *  gate; that's how gas giants and Sol get settled). */
function claimableBodies(state: GameState) {
  // A GATE IS NOT A WORLD.
  //
  // Megastructure sites are game_bodies — that is what gives them an
  // orbit, a position and an owner for free — and they carry
  // owner_faction_id like anything else. This function predates them and
  // counted every row, so each structure you raised added one to your
  // own tally AND one to the total. (A+N)/(T+N) beats A/T for any A < T,
  // so building doors was a strictly better path to a domination win
  // than taking planets, and it diluted every rival's share while it did
  // it. A player could win by spamming warp gates.
  //
  // The comment above about the political map is the tell: that shading
  // is settlement-derived (state.js reads game_settlements), so the map
  // and the win condition were counting two different things and the
  // game could declare a winner the map did not show.
  return state.bodies.filter(b => b.type !== 'megastructure');
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
