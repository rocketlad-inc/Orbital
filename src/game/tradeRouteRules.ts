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
