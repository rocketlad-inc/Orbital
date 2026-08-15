// ============================================================
// routeSelectors — the ONE place that answers "what does this route
// have to do with this ship / this body?" (DESIGN-trade-v2 §10).
//
// Before Trade v2 three questions were asked by reading fields directly,
// in five separate files:
//
//   routes.find(r => r.shipId === ship.id)        ShipPanel, MapCanvas
//   routes.some(r => r.originBodyId === body.id)  BodyInspector
//   new Set(routes.map(r => r.shipId))            WorldMenuOverlay
//   routes.filter(r => r.destBodyId === 'sol')    WorldMenuOverlay
//
// Every one of those assumptions died with this release: a route now has
// MANY ships (carriers and guards) and MANY stops. Fixing them in place
// would have meant five copies of the new logic — which is exactly the
// mirror-drift this codebase keeps re-learning (the emblem tables, the
// upkeep tables, the settlement-cost literals). So they live here once
// and every surface imports them.
//
// Everything degrades gracefully when `stops` / `ships` are absent: a
// stale client bundle, or a route the server hasn't backfilled yet,
// falls back to originBodyId / destBodyId / shipId and behaves exactly
// as it did before.
// ============================================================

import type { TradeRoute, TradeRouteStop, TradeRouteShip } from '../types';

/** The itinerary, always as a list — synthesised from origin/dest for
 *  any route that predates the stop table. */
export function routeStops(route: TradeRoute): TradeRouteStop[] {
  if (route.stops && route.stops.length >= 2) {
    return [...route.stops].sort((a, b) => a.sequence - b.sequence);
  }
  return [
    { sequence: 0, bodyId: route.originBodyId, action: 'pickup',
      takeMetal: true, takeGold: true, takeScience: true },
    { sequence: 1, bodyId: route.destBodyId, action: 'dropoff',
      takeMetal: true, takeGold: true, takeScience: true },
  ];
}

/** The crew, always as a list — synthesised from shipId for a route
 *  with no crew rows yet. */
export function routeShips(route: TradeRoute): TradeRouteShip[] {
  if (route.ships && route.ships.length > 0) return route.ships;
  return [{
    shipId: route.shipId, role: 'carrier', nextStopSeq: 0,
    cargo: { fuel: 0, ore: 0, credits: 0, science: 0 },
  }];
}

export const routeCarriers = (route: TradeRoute): TradeRouteShip[] =>
  routeShips(route).filter(s => s.role === 'carrier');

export const routeGuards = (route: TradeRoute): TradeRouteShip[] =>
  routeShips(route).filter(s => s.role === 'guard');

/** Every route this ship is employed by, in ANY role. The replacement
 *  for `find(r => r.shipId === ship.id)`, which silently missed a
 *  second carrier and every guard. */
export function routesForShip(routes: TradeRoute[], shipId: string): TradeRoute[] {
  return routes.filter(r => routeShips(r).some(s => s.shipId === shipId));
}

/** The one route a ship is employed by, or null. One job per hull is a
 *  server invariant (unique index), so "the first" is "the only". */
export function routeForShip(routes: TradeRoute[], shipId: string): TradeRoute | null {
  return routesForShip(routes, shipId)[0] ?? null;
}

/** What this ship does on that route — for badges and stance copy. */
export function shipRoleOn(route: TradeRoute, shipId: string): 'carrier' | 'guard' | null {
  return routeShips(route).find(s => s.shipId === shipId)?.role ?? null;
}

/** Every ship with a job on any route. Replaces
 *  `new Set(routes.map(r => r.shipId))`, which counted only primaries
 *  and so left extra carriers and guards looking idle. */
export function employedShipIds(routes: TradeRoute[]): Set<string> {
  const out = new Set<string>();
  for (const r of routes) for (const s of routeShips(r)) out.add(s.shipId);
  return out;
}

/** Does this route touch this body AT ALL — as any stop, not just as
 *  its origin? A milk run's middle stops are served by the route even
 *  though they are neither origin nor destination. */
export function routeTouchesBody(route: TradeRoute, bodyId: string): boolean {
  return routeStops(route).some(s => s.bodyId === bodyId);
}

/** Routes stopping at a body — the Trade tab's whole question. */
export const routesAtBody = (routes: TradeRoute[], bodyId: string): TradeRoute[] =>
  routes.filter(r => routeTouchesBody(r, bodyId));

/** Is anything COLLECTING from this body? The body menu's "your output
 *  is going nowhere" warning turns on this, and asking it of
 *  originBodyId alone made every middle stop of a milk run look
 *  unserved. */
export function routeCollectsFrom(route: TradeRoute, bodyId: string): boolean {
  return routeStops(route).some(s => s.bodyId === bodyId && s.action === 'pickup');
}

export const anyRouteCollectsFrom = (routes: TradeRoute[], bodyId: string): boolean =>
  routes.some(r => routeCollectsFrom(r, bodyId));

/** Where a route ultimately delivers — its last dropoff. Replaces
 *  `r.destBodyId` for anything asking "is this feeding X". */
export function routeFinalDropoff(route: TradeRoute): string {
  const stops = routeStops(route);
  for (let i = stops.length - 1; i >= 0; i--) {
    if (stops[i].action === 'dropoff') return stops[i].bodyId;
  }
  return route.destBodyId;
}

export const routeDeliversTo = (route: TradeRoute, bodyId: string): boolean =>
  routeStops(route).some(s => s.bodyId === bodyId && s.action === 'dropoff');

/** A route with no freighter, counting down to auto-cancel. */
export const isStalled = (route: TradeRoute): boolean =>
  route.stalledSinceTick != null;

/** Ticks left before a stalled route cancels itself. Mirrors
 *  ROUTE_STALL_TICKS in worker/room.js — if that moves, this moves. */
export const ROUTE_STALL_TICKS = 30;

export function stallTicksLeft(route: TradeRoute, currentTick: number): number | null {
  if (route.stalledSinceTick == null) return null;
  return Math.max(0, ROUTE_STALL_TICKS - (currentTick - route.stalledSinceTick));
}

/** One-line summary for a route card: "Ceres → Pallas → Luna". Falls
 *  back to the route's name when it has one. */
export function routeLabel(
  route: TradeRoute,
  bodyName: (id: string) => string,
): string {
  if (route.name) return route.name;
  const stops = routeStops(route);
  return stops.map(s => bodyName(s.bodyId)).join(' → ');
}
