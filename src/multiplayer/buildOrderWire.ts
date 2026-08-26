// ============================================================
// BUILD-ORDER WIRE FIELDS — which ids the server needs qualified.
//
// The server stores most per-game rows under a namespaced id
// ("<gameId>:ariel", "<gameId>:fl_yyv7ai") and the client strips that
// prefix on the way in, so every id leaving the client has to be put
// back. The build call did this for the shipyard in the URL and then
// sent the build ORDER's ids raw, so `go_to` looked up a body called
// "ariel" in a table where it is called "<gameId>:ariel" and answered
// 404 "destination body not found" — reported by a live player the
// first time anyone tried to give a hull a standing order.
//
// NOT EVERY ID. Trade route ids are minted flat ("-0e-UM0v254BER5H",
// no prefix), so qualifying one would break a call that works today.
// That asymmetry is the whole reason this is a function with tests
// rather than a rule someone has to remember at each call site.
// ============================================================

export interface BuildOrderIntent {
  /** 'stay' is the explicit "wait at the yard" — the override a queued
   *  hull needs once its station has a standing order. It carries no
   *  target and does nothing at roll-out. */
  buildOrder?: 'go_to' | 'defensive' | 'hold' | 'trade_route' | 'join_fleet' | 'stay';
  buildOrderBodyId?: string;
  buildOrderRouteId?: string;
  buildOrderFleetId?: string;
}

/**
 * The body of a PATCH that RETARGETS one queued hull.
 *
 * Differs from the build call in one way that matters: clearing an order
 * has to be said out loud. An absent build_order key reads as "leave it
 * alone", so "wait here" — the value every other value has to be
 * reachable FROM — would be the one setting the editor could not send.
 */
export function buildOrderPatchBody(
  intent: BuildOrderIntent,
  qualify: (id: string) => string,
): Record<string, string | null> {
  if (!intent.buildOrder) return { build_order: null };
  return buildOrderWireFields(intent, qualify);
}

/** The build-order half of the /build body. `qualify` puts the game
 *  namespace back on an id the client stripped. */
export function buildOrderWireFields(
  intent: BuildOrderIntent,
  qualify: (id: string) => string,
): Record<string, string> {
  if (!intent.buildOrder) return {};
  const out: Record<string, string> = { build_order: intent.buildOrder };
  // game_bodies.id and game_fleets.id are both namespaced.
  if (intent.buildOrderBodyId) out.build_order_body_id = qualify(intent.buildOrderBodyId);
  if (intent.buildOrderFleetId) out.build_order_fleet_id = qualify(intent.buildOrderFleetId);
  // game_trade_routes.id is not. Sent as-is.
  if (intent.buildOrderRouteId) out.build_order_route_id = intent.buildOrderRouteId;
  return out;
}
