// ============================================================
// What you can DO at a world is decided settlement by settlement.
//
// Body ownership is derived: the faction with the most settlements on a
// world owns it, and a tie changes nothing (recomputeBodyOwnership). So a
// world can be a rival's while one of its settlements is yours -- found a
// station beside their city, or seize the wreck of their station while
// the city still stands. The server has always allowed that and gates
// each action on the SETTLEMENT (ship builds: "a settlement of yours
// here"; upgrades: "your settlement").
//
// The World Menu gated everything on the BODY instead. Noah seized Wu
// Tang's wrecked station on Io (2026-09-24) with their city still
// standing: 1 city to 1 station, a tie, Io stayed theirs -- and his own
// station's upgrades and shipyard were greyed out, drawn in their
// colours, as if he had taken nothing.
// ============================================================

import type { Settlement, Faction } from '../../types';

export interface WorldControl {
  /** Your city here, if any: the surface column acts on it. */
  myCity: Settlement | null;
  /** Your station here, if any: the orbit column and the yard act on it. */
  myStation: Settlement | null;
  /** You hold a settlement here, which is what the server asks before it
   *  queues a hull or edits a yard order. */
  canCommand: boolean;
}

export function worldControl(here: Settlement[]): WorldControl {
  const myCity = here.find(s => s.type === 'city' && s.ownedBy === 'player') ?? null;
  const myStation = here.find(s => s.type === 'station' && s.ownedBy === 'player') ?? null;
  return { myCity, myStation, canCommand: !!(myCity || myStation) };
}

/** The livery a settlement flies: its OWN owner's, never the world's. */
export function settlementLivery(
  s: Settlement | null | undefined,
  factions: Faction[],
): { color: string; color2: string | null } | null {
  if (!s) return null;
  const f = factions.find(x => x.id === s.ownedBy);
  if (!f?.color) return null;
  return { color: f.color, color2: f.color2 ?? null };
}
