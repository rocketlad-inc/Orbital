/**
 * game_fleets.id is namespaced per game ("Jt4AQbYy7M4l:fl_yyv7ai") and
 * the worker looks a fleet up by that exact id. MultiplayerGameProvider
 * strips the prefix at the deserialization boundary, so every fleet id
 * the UI holds is the bare "fl_yyv7ai" — send that and the server
 * answers 404 "fleet not found".
 *
 * Every per-fleet API path goes through here, so the two panels that
 * drive fleets cannot drift apart again (ShipPanel's DETACH / LEAVE /
 * DISBAND / ADD SHIPS all 404'd while FleetPanel's worked).
 *
 * Pass-through if the id already carries a prefix.
 */
export function qualifyFleetId(gameId: string, fleetId: string): string {
  return fleetId.includes(':') ? fleetId : `${gameId}:${fleetId}`;
}

/** `/fleets/<qualified id><suffix>`, relative to `/api/games/:gameId`. */
export function fleetPath(gameId: string, fleetId: string, suffix = ''): string {
  return `/fleets/${encodeURIComponent(qualifyFleetId(gameId, fleetId))}${suffix}`;
}
