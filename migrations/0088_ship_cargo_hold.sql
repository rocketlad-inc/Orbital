-- Freighters get a PHYSICAL cargo hold (Lorne: "Cargo should remain in
-- a freighter until delivered either automatically or manually").
--
-- Until now cargo lived on the trade-route row, which is exactly why it
-- could not survive the route: cancel a route and the hold TELEPORTED
-- home to the faction pool from wherever the ship was. These columns are
-- the ship's own hold. The route machine still stages its per-leg cargo
-- on the route row (its loop is leg-scoped by design); what changes is
-- every path that ENDS a route with goods aboard — cancel, destination
-- lost — now moves the load here instead of to the pool, and the ship
-- carries it until it is delivered (folded into the next route and
-- hauled to its destination) or unloaded manually.
--
-- Piracy reads these too: a killer's loot is what was physically aboard,
-- route cargo and hold cargo alike.

ALTER TABLE game_ships ADD COLUMN cargo_fuel    REAL NOT NULL DEFAULT 0;
ALTER TABLE game_ships ADD COLUMN cargo_metal   REAL NOT NULL DEFAULT 0;
ALTER TABLE game_ships ADD COLUMN cargo_gold    REAL NOT NULL DEFAULT 0;
ALTER TABLE game_ships ADD COLUMN cargo_science REAL NOT NULL DEFAULT 0;
