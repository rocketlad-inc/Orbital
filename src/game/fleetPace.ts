// ============================================================
// FLEET PACE — a fleet moves as one unit, at its slowest ship's speed.
//
// Lorne, 2026-09-22: "Fleets should move at the speed of their slowest
// ship, as one unit."
//
// The QA battle test sent a 70-hull fleet to Mars and it arrived smeared
// over four ticks (T24.3 .. T28.1): the fast hulls landed alone and
// fought alone. A later order promised "all 69 land on T+57" and the
// server stored T53.0 .. T56.3, because the formation throttle shaped
// the PREVIEW and COMMIT re-planned every hull at full speed.
//
// So the rule lives where acceleration is decided, not in one button:
// every launch, preview, chained leg and tour asks for a hull's engine
// acceleration here, and a fleet member gets the SLOWEST acceleration in
// its fleet. Every route that moves ships — ship panel, fleet panel,
// group bar, chained orders — therefore flies the fleet together, and
// the plan the server stores is the plan the player was shown.
//
// Only engine parts and tech set multiplayer travel. The hull's speed
// CLASS (travelAccelMultiplierOf) is used only by the frozen
// single-player sim, so it is deliberately absent here.
// ============================================================

import type { Faction, Ship } from '../types';
import { fromG, DEFAULT_ENGINE_G } from '../physics/torchTransfer';
import { engineGModifier } from './techs';
import { engineAccelMultiplier } from './shipParts';

type FactionTech = Record<string, { levels?: Record<string, number> } | undefined> | undefined;

/** One hull's own torch acceleration: faction engine g, flight tech, engine parts. */
export function shipEngineAccel(ship: Ship, factions: Faction[], factionTech: FactionTech): number {
  const faction = factions.find(f => f.id === ship.ownedBy);
  const tech = factionTech?.[ship.ownedBy];
  return fromG(faction?.engineG ?? DEFAULT_ENGINE_G)
    * engineGModifier(tech as never)
    * engineAccelMultiplier(ship.parts, tech?.levels?.propulsion ?? 0);
}

/**
 * The acceleration this hull should FLY at: its own, or — when it sails
 * in a fleet — the slowest of its fleet-mates'. Detached members fly
 * alone, and the destroyed carry no vote.
 */
export function fleetEngineAccel(
  ship: Ship, ships: Ship[], factions: Faction[], factionTech: FactionTech,
): number {
  const own = shipEngineAccel(ship, factions, factionTech);
  if (!ship.fleetId || ship.fleetDetached) return own;
  let slowest = own;
  for (const m of ships) {
    if (m.id === ship.id || m.fleetId !== ship.fleetId || m.fleetDetached) continue;
    if ((m.hp ?? 1) <= 0) continue;
    slowest = Math.min(slowest, shipEngineAccel(m, factions, factionTech));
  }
  return slowest;
}
