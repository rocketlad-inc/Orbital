// ============================================================
// The stance a hull has when nobody has set one (game_ships.stance NULL).
//
// Warships attack on sight. CIVILIAN hulls (colony ships, freighters)
// default to DEFENSIVE: they never start a fight, an unarmed one never
// fires at all, and a freighter someone fitted with guns still returns
// fire. It used to be 'attack' for every class, so an unarmed colony
// ship read STANCE: ATTACK (playtest R2-C10), and an armed freighter
// parked anywhere made its whole empire an aggressor there.
//
// MIRRORED in src/game/stance.ts (the client resolves NULL the same way).
// ============================================================

export const CIVILIAN_CLASSES = new Set(['colony', 'freighter']);

export function defaultStanceFor(shipClass) {
  return CIVILIAN_CLASSES.has(shipClass) ? 'defensive' : 'attack';
}

/** A row's stance with NULL resolved: what the tick actually flies. */
export function resolvedStance(stance, shipClass) {
  return stance === 'attack' || stance === 'defensive' || stance === 'hold'
    ? stance : defaultStanceFor(shipClass);
}
