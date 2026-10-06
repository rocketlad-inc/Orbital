// ============================================================
// mapPick — which hull a click on the map means (MULTIPLAYER).
//
// Pure helpers for MapCanvas's pointer handling, kept out of the
// component so the rules can be tested without a canvas.
//
// Two playtest reports (Franz, 2026-10):
//
//  1. "Often when intercepting ships get overlapped and it's difficult to
//     select one or the other." The hit test always took the hull NEAREST
//     the pointer, so whichever sprite sat a pixel closer won every click
//     and the one under it could not be reached at all. Now a click on the
//     hull that is ALREADY selected, when other hulls share the spot,
//     moves on to the next one — click again, get the next, wrapping round.
//
//  2. "I often find myself using the box selection to select only one
//     ship." A box that catches a single ship (or a single fleet) now does
//     what clicking it would have done: opens that ship's panel.
// ============================================================

import type { Fleet, Ship } from '../types';

export interface PickHit {
  /** The id a click resolves to (a fleet hull resolves to its flagship). */
  id: string;
  /** Pointer distance, canvas px. */
  d: number;
}

/** Hits nearest-first, one entry per id (a fleet's flagship can be hit
 *  through several formation slots; its nearest one counts). Stable for
 *  equal distances, so ties keep the caller's scan order — the same
 *  winner the single-pick hit test chooses. */
export function orderPickHits(hits: readonly PickHit[]): string[] {
  const best = new Map<string, { d: number; at: number }>();
  hits.forEach((h, at) => {
    const cur = best.get(h.id);
    if (!cur || h.d < cur.d) best.set(h.id, { d: h.d, at: cur ? Math.min(cur.at, at) : at });
  });
  return Array.from(best.entries())
    .sort((a, b) => (a[1].d - b[1].d) || (a[1].at - b[1].at))
    .map(([id]) => id);
}

export interface CycleResult {
  /** The hull this click selects. */
  id: string;
  /** The cycle order to remember for the next click (empty when only one
   *  hull is under the pointer — nothing to cycle). */
  order: string[];
  /** Position of `id` in `order` (0-based), for "2 of 3". */
  index: number;
}

/**
 * Resolve a click over `hits` (nearest-first ids under the pointer).
 *
 * - One hull: that hull, exactly as before.
 * - Several, and the SELECTED hull is one of them: the next one after it.
 *   The order is the one remembered from the previous click
 *   (`prevOrder`), so it does not reshuffle as the hulls drift and the
 *   nearest-first ranking changes between clicks — a three-way pile would
 *   otherwise ping-pong between two of them. Hulls that have left the
 *   spot drop out; hulls that arrived join at the end.
 * - Several, none selected: the nearest, as before, and the order starts.
 */
export function cyclePick(
  hits: readonly string[],
  selectedId: string | null | undefined,
  prevOrder: readonly string[] | null | undefined,
): CycleResult | null {
  if (hits.length === 0) return null;
  if (hits.length === 1) return { id: hits[0], order: [], index: 0 };
  const here = new Set(hits);
  if (selectedId && here.has(selectedId)) {
    const order = (prevOrder && prevOrder.includes(selectedId))
      ? prevOrder.filter(id => here.has(id))
      : hits.slice();
    for (const id of hits) if (!order.includes(id)) order.push(id);
    const index = (order.indexOf(selectedId) + 1) % order.length;
    return { id: order[index], order, index };
  }
  return { id: hits[0], order: hits.slice(), index: 0 };
}

/**
 * The single hull a box selection stands for, or null when it caught a
 * real group. "Single" means what the player sees as one thing:
 *
 * - exactly one ship;
 * - or every caught hull resolves to the same click target (a fleet's
 *   escorts all resolve to its flagship — `clickTargetOf` is the map's
 *   formation-slot lookup);
 * - or every caught hull belongs to the same fleet and its flagship is
 *   among them (a small fleet the map does not fold into one icon).
 */
export function boxSingleTarget(
  caught: readonly string[],
  ships: readonly Ship[],
  fleets: readonly Fleet[] | undefined,
  clickTargetOf: (shipId: string) => string | undefined,
): string | null {
  if (caught.length === 0) return null;
  const targets = new Set(caught.map(id => clickTargetOf(id) ?? id));
  if (targets.size === 1) return targets.values().next().value ?? null;

  const byId = new Map(ships.map(s => [s.id, s]));
  const fleetId = byId.get(caught[0])?.fleetId;
  if (!fleetId) return null;
  for (const id of caught) {
    const s = byId.get(id);
    if (!s || s.fleetId !== fleetId || s.fleetDetached) return null;
  }
  const lead = fleets?.find(f => f.id === fleetId)?.leadShipId;
  return lead && caught.includes(lead) ? lead : null;
}
