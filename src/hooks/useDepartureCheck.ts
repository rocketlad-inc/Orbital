// ============================================================
// useDepartureCheck
//
// "Does this group order leave a world of mine with no warships?" plus
// the trip time, asked BEFORE the burn fires. A group send launches at
// once and cannot be called back after a tick, so the one question worth
// asking is asked here (playtest R2-C2: the whole home fleet left for
// Centauri A on one click, with the capital left bare and no ETA shown).
//
// Returns null when nothing is left undefended: an ordinary send goes
// straight through, with no extra click.
// ============================================================

import { useCallback } from 'react';
import { useGameContext } from '../state/gameContext';
import { expandFleetIds, worldsLeftUndefended } from '../game/leftUndefended';

export interface DepartureWarning {
  /** Names of the worlds that would be left with no warships. */
  worlds: string[];
  /** Where the group is going (the first stop of a chain). */
  destName: string;
  /** Whole ticks until the slowest hull arrives; null if none could be planned. */
  etaTicks: number | null;
}

export function useDepartureCheck() {
  const { gameState, planTorchPreview } = useGameContext();
  return useCallback((shipIds: string[], destBodyId: string): DepartureWarning | null => {
    const ids = expandFleetIds(shipIds, gameState.ships);
    const bare = worldsLeftUndefended(ids, destBodyId, gameState.ships, gameState.settlements);
    if (bare.length === 0) return null;
    const nameOf = (id: string) => gameState.bodies.find(b => b.id === id)?.name ?? id;
    let eta: number | null = null;
    for (const id of ids) {
      const ship = gameState.ships.find(s => s.id === id);
      if (!ship || ship.transit) continue;
      // Dry run (commit=false): the same planner the send uses, staged nowhere.
      const plan = planTorchPreview(id, destBodyId, 0, false);
      if (plan) eta = Math.max(eta ?? 0, plan.arriveTick - gameState.currentTick);
    }
    return {
      worlds: bare.map(nameOf),
      destName: nameOf(destBodyId),
      etaTicks: eta == null ? null : Math.max(1, Math.ceil(eta)),
    };
  }, [gameState.ships, gameState.settlements, gameState.bodies, gameState.currentTick, planTorchPreview]);
}
