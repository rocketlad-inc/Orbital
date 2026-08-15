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
  // UNDEFINED and EMPTY mean different things, and conflating them is
  // what produced a card reading "STALLED — no freighter" directly above
  // "Runs it · Palashite". Undefined = the server never said (a stale
  // bundle, a pre-crew route), so fall back to ship_id. EMPTY = the
  // server said nobody is aboard, which is the truth for a stalled lane
  // — inventing a carrier there showed a freighter that wasn't on the
  // route and offered a remove button for a row that doesn't exist.
  if (route.ships) return route.ships;
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
export function employedShipIds(
  routes: TradeRoute[],
  /** One-off shipments in flight. A freighter hauling one is refused by
   *  the server (shipEmployment checks trade_deliveries too), so leaving
   *  these out offers the player a hull that can only answer with a 409
   *  — the exact failure the routes half of this set exists to prevent. */
  deliveries?: Array<{ shipId: string | null; status?: string }>,
): Set<string> {
  const out = new Set<string>();
  for (const r of routes) for (const s of routeShips(r)) out.add(s.shipId);
  for (const d of deliveries ?? []) if (d.shipId) out.add(d.shipId);
  return out;
}

/** EVERY ROUTE YOUR GOODS TRAVEL ON — not merely the ones you own.
 *
 *  A folded lane belongs to whichever side leads it and hauls for both,
 *  so `routes.filter(r => r.ownedBy === 'player')` silently drops the
 *  lane carrying half your trade. Anything asking "is this body served"
 *  or "is anything collecting here" has to ask about the deal, not the
 *  deed. */
export function routesIAmPartyTo(routes: TradeRoute[]): TradeRoute[] {
  return routes.filter(
    r => r.ownedBy === 'player' || r.counterpartyFactionId === 'player',
  );
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

/** The two parties on a lane, as colours (Lorne: "my color on the left,
 *  theirs on the right, with a gradient in the middle, and domestic are
 *  just my color").
 *
 *  A trade route is the one object in the game that can belong to two
 *  empires at once, so its identity colour has to be able to say so.
 *  Domestic hauling is one faction's business end to end and gets one
 *  flat colour; an international lane reads left-to-right as "mine →
 *  theirs", which is also the direction the circuit is drawn in.
 *
 *  `mine` is always the caller's colour regardless of who OWNS the
 *  route — on a consolidated lane the hull may be the partner's, but
 *  the player still reads the card as "my end is on the left".
 */
export function routePartyColors(
  route: TradeRoute,
  myColor: string,
  colorOfFaction: (factionId: string) => string | undefined,
): { mine: string; theirs: string | null; international: boolean } {
  // Whoever isn't me. `ownedBy`/`counterpartyFactionId` are rewritten to
  // the player token for the caller, so the other party is whichever of
  // the two is NOT that token.
  const parties = [route.ownedBy, route.counterpartyFactionId].filter(Boolean) as string[];
  const other = parties.find(p => p !== 'player');
  if (!other) return { mine: myColor, theirs: null, international: false };
  return {
    mine: myColor,
    theirs: colorOfFaction(other) ?? '#7a8a9a',
    international: true,
  };
}

/** The CSS paint for a lane: a flat colour domestically, a left-to-right
 *  handover internationally. One helper so the route card's accent and
 *  the diagram's connecting line can never drift apart. */
export function routeGradient(parties: { mine: string; theirs: string | null }): string {
  return parties.theirs
    ? `linear-gradient(90deg, ${parties.mine} 0%, ${parties.mine} 18%, ${parties.theirs} 82%, ${parties.theirs} 100%)`
    : parties.mine;
}
