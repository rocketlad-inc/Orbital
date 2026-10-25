// The stance a hull has when nobody has set one. MIRRORS worker/shipStance.js:
// civilian hulls (colony, freighter) default to DEFENSIVE, so they never
// start a fight; warships attack on sight (playtest R2-C10).

export type Stance = 'attack' | 'defensive' | 'hold';

const CIVILIAN_CLASSES: ReadonlySet<string> = new Set(['colony', 'freighter']);

export function defaultStanceFor(shipClass: string): Stance {
  return CIVILIAN_CLASSES.has(shipClass) ? 'defensive' : 'attack';
}

export function resolvedStance(stance: unknown, shipClass: string): Stance {
  return stance === 'attack' || stance === 'defensive' || stance === 'hold'
    ? stance : defaultStanceFor(shipClass);
}
