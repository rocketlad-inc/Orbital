-- FUEL IS ELIMINATED. Not disabled, not hidden — zeroed out of every
-- table that holds it, in every live game.
--
-- Fuel had already left the ECONOMY (yields zeroed, income zero,
-- starting stock zero, Dyson target zero) but it had not left the
-- DATABASE: legacy rows still carried non-zero amounts in ship tanks,
-- freighter holds, settlement stockpiles, open offers and standing
-- agreements. Those numbers could never be spent, never be produced,
-- and — now that the client has dropped fuel from ResourceBundle
-- entirely — never even be displayed. A hidden non-zero balance is
-- worse than a visible dead one: an agreement denominated in fuel
-- parks on its first pickup and starves itself to death, blaming a
-- resource the player cannot see, hold, or acquire.
--
-- The COLUMNS stay. Dropping twenty of them across ten tables would
-- rewrite every table in D1 for zero player-visible gain, and the
-- worker's INSERTs still name them. They are inert: nothing writes a
-- non-zero value any more (worker refuses fuel in new offers; the
-- unload path discards legacy hold fuel rather than banking it), so
-- once zeroed they stay zeroed.
--
-- Idempotent by construction: setting a column to 0 is safe to re-run,
-- which the migration-rerun sim exercises on every request.

UPDATE game_factions        SET fuel = 0 WHERE fuel != 0;
UPDATE game_ships           SET fuel = 0, fuel_max = 0, cargo_fuel = 0
                             WHERE fuel != 0 OR fuel_max != 0 OR cargo_fuel != 0;
UPDATE game_bodies          SET yield_fuel = 0 WHERE yield_fuel != 0;
UPDATE game_settlements     SET stockpile_fuel = 0 WHERE stockpile_fuel != 0;
UPDATE game_trade_routes    SET cargo_fuel = 0, per_run_fuel = 0
                             WHERE cargo_fuel != 0 OR per_run_fuel != 0;
UPDATE game_trade_route_ships SET cargo_fuel = 0 WHERE cargo_fuel != 0;
-- NOTE: game_trade_route_stops has NO cargo_fuel column — a stop is a
-- plan, not a hold. Naming it here threw "no such column", which in
-- this codebase does not fail one statement: it wedges the whole
-- bundle for every request, exactly the way 0089 once did. Caught by
-- sim/fuelPurge.mjs before it ever reached prod.
UPDATE trade_offers         SET offer_fuel = 0, request_fuel = 0
                             WHERE offer_fuel != 0 OR request_fuel != 0;
UPDATE trade_deliveries     SET fuel = 0 WHERE fuel != 0;
UPDATE trade_agreements     SET a_fuel = 0, b_fuel = 0
                             WHERE a_fuel != 0 OR b_fuel != 0;
