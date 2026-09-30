// ============================================================
// Which saved design a player may pick, in the two places they pick one:
// retrofitting a hull from its own panel, and building at a yard.
//
// Both used to read only the class's ACTIVE design. Noah, 2026-09-30:
// "to retrofit a single ship, you need to go to the fleet designer, set
// the template to whatever you're changing to, then set it as active,
// THEN head back to the individual ship and order the retrofit." The
// server already takes any of your designs of the right class for both a
// refit order and a build; only the menus were hard-wired to the active
// one.
// ============================================================

import type { Ship, ShipDesign } from '../types';
import { sanitizeParts } from './shipParts';

export function sameFit(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort(), y = [...b].sort();
  return x.every((v, i) => v === y[i]);
}

/** Active first, then by name: the list opens on what the player
 *  already made their default. */
function ordered(designs: ShipDesign[]): ShipDesign[] {
  return [...designs].sort((a, b) =>
    Number(!!b.isActive) - Number(!!a.isActive) || a.name.localeCompare(b.name));
}

/** Designs this hull could be refitted to: same class, a DIFFERENT fit
 *  from what it carries now. */
export function retrofitChoices(ship: Ship, designs: ShipDesign[] | undefined): ShipDesign[] {
  const now = sanitizeParts(ship.parts ?? []);
  return ordered((designs ?? []).filter(d =>
    d.shipClass === ship.class && !sameFit(now, sanitizeParts(d.parts ?? []))));
}

/** What the retrofit picker opens on: the order already standing, else
 *  the active design, else the first choice. */
export function defaultRetrofitPick(ship: Ship, choices: ShipDesign[]): ShipDesign | undefined {
  return choices.find(d => d.id === ship.refitPendingDesignId)
    ?? choices.find(d => d.isActive)
    ?? choices[0];
}

/** Designs a yard can build this class from, active first. */
export function buildChoices(shipClass: string, designs: ShipDesign[] | undefined): ShipDesign[] {
  return ordered((designs ?? []).filter(d => d.shipClass === shipClass));
}
