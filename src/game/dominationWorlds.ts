// ============================================================
// The worlds the domination win counts, as the SERVER counts them
// (worker/factions.js countOwnedBodiesPerFaction, room.js win check):
// worlds only (no rocks, L-points or structures), not obliterated or
// destroyed, and in the home system only (the far systems sit under a
// barycenter on a pretend orbit, systems.js isStellarAnchor).
//
// The Situation Report's domination row counted every body in state, 92
// on a trial map against the server's 60, so its "N more to win" and
// the Standing panel's target disagreed (playtest R2-C5).
// ============================================================

import type { Body } from '../types';

const NON_WORLD_TYPES: ReadonlySet<string> = new Set(['meteoroid', 'lagrange', 'megastructure']);
/** Mirrors PRETEND_ORBIT_PERIOD in systemGrouping.ts / systems.js. */
const PRETEND_ORBIT_PERIOD = 1e9;

export function dominationWorlds(bodies: Body[]): Body[] {
  const byId = new Map(bodies.map(b => [b.id, b]));
  const far = (b: Body): boolean => {
    let cur: Body | undefined = b;
    for (let i = 0; i < 10 && cur; i++) {
      if ((cur.orbitPeriod ?? 0) >= PRETEND_ORBIT_PERIOD) return true;
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
    return false;
  };
  return bodies.filter(b => !NON_WORLD_TYPES.has(b.type)
    && b.obliteratedAtTick == null
    && b.destroyedAtTick == null
    && !far(b));
}

/** Worlds needed to win: strictly more than the fraction (room.js). */
export function dominationTarget(total: number, fraction = 0.6): number {
  return total > 0 ? Math.floor(total * fraction) + 1 : 0;
}
