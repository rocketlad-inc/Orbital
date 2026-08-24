import type { Body, GameState } from '../types';
// ============================================================
// tradeRouteRules — is this itinerary flyable?
//
// THIS IS A MIRROR of validateStops in worker/tradeRoutesV2.js, and it
// exists as its own module because the copy that used to live inline in
// RouteComposer drifted and silently disabled the entire mining
// feature: it demanded a stop with action 'pickup', so a mine -> dropoff
// run — the only shape a mining route has — was reported as "nothing is
// picked up anywhere on this run", the save button stayed dead and no
// projection was ever fetched.
//
// The server had it right the whole time (`pickup || mine`), and its own
// comment calls out that rejecting a route for having no pickup is
// "exactly the route the whole feature is about". Nothing failed. The
// server was never asked.
//
// tradeRouteRules.test.ts pins these against the server source.
// ============================================================

export type StopAction = 'pickup' | 'dropoff' | 'mine';

export interface RouteStopLike {
  action: StopAction;
}

/** Minimum stops on a route. MIRRORS worker/tradeRoutesV2.js. */
export const MIN_STOPS = 2;

/**
 * Why this itinerary cannot be flown, or null if it can.
 *
 * Returns the REASON rather than a boolean so the composer's disabled
 * button and its explanatory line cannot disagree with each other —
 * they were separate expressions before, which is how the button and
 * the message could describe different problems.
 */
export function routeProblem(stops: RouteStopLike[]): string | null {
  if (stops.length < MIN_STOPS) return 'Add at least two stops.';
  // MINING COUNTS AS LOADING. A mine stop fills the hold off a rock;
  // that is a pickup in every sense except the label.
  if (!stops.some(s => s.action === 'pickup' || s.action === 'mine')) {
    return 'Nothing is loaded anywhere on this run.';
  }
  if (!stops.some(s => s.action === 'dropoff')) {
    return 'Nothing is dropped off anywhere on this run.';
  }
  return null;
}

/** Convenience for callers that only need the yes/no. */
export function routeIsValid(stops: RouteStopLike[]): boolean {
  return routeProblem(stops) === null;
}

// ---------------------------------------------------------------
// WHICH BODIES CAN BE STOPS.
//
// Lifted out of RouteComposer so the meteoroid card's "start a mining
// run" can apply the SAME dropoff rule the composer does. A second copy
// of "a dropoff must be a terraformed world you live on" is precisely
// the shape of the bug that disabled mining routes in the first place.
// ---------------------------------------------------------------

export function eligibleBodies(gameState: GameState) {
  const mine = new Set(
    gameState.settlements.filter(s => s.ownedBy === 'player').map(s => s.bodyId),
  );
  const pickup: Body[] = [];
  const dropoff: Body[] = [];
  const mineable: Body[] = [];
  /** Unfinished construction sites. A DROPOFF that is not a settlement
   *  and not terraformed — the two things every other dropoff has — so
   *  it needs its own list rather than a looser rule on the old one. */
  const sites: Body[] = [];
  const megas = gameState.megastructures ?? {};
  for (const b of gameState.bodies) {
    // A SITE NEEDS NO SETTLEMENT, same as a rock, and for the same
    // reason: the thing you are delivering to IS the destination. Tested
    // before the ownership gate so an ally's half-built gate can be
    // supplied — anyone may pour freight into a site, exactly as the
    // manual deliver endpoint allows.
    if (b.type === 'megastructure') {
      const m = megas[b.id];
      // A finished structure wants nothing. Listing it would produce a
      // route the server refuses with 'already_done', and the player
      // would have no idea why the stop was offered.
      if (m && m.status === 'building') sites.push(b);
      continue;
    }
    // A ROCK NEEDS NO SETTLEMENT — that is the whole point of mining, so
    // it is tested before the ownership gate below. Undiscovered rocks
    // never reach the client, so anything with a mineral kind is
    // something this player has surveyed. An exhausted one is left out:
    // the server would refuse the route and the player would have no
    // idea why.
    if (b.mineralKind && (b.mineralRemaining ?? 0) > 0) { mineable.push(b); continue; }
    if (!mine.has(b.id)) continue;
    if (b.id === 'sol') continue;              // the Dyson line has its own path
    pickup.push(b);
    if (b.terraformedAtTick != null) dropoff.push(b);
  }
  return { pickup, dropoff, mineable, sites };
}
