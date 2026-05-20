-- Force-finish all in-flight legacy Bezier transfers.
--
-- Phase 6 of the Bezier→Torch migration. The game's transfer model
-- changed from precomputed Hohmann-Bezier curves to a constant-thrust
-- (torch) brachistochrone integrated tick-by-tick. The new client
-- ignores legacy ship.transfer / ship.pendingTransfer fields and
-- drives ships via ship.transit instead.
--
-- Per the deploy plan (Q3 option B from the original migration spec):
-- any maneuver node that's currently committed-but-not-fired OR
-- in_transit at the moment this migration runs gets force-finished.
-- The ship is teleported into a parking orbit around the target body,
-- the node is marked 'cancelled', and any subsequent post-Bezier code
-- path that touched ship.transfer becomes a no-op.
--
-- Without this migration, active multiplayer games at deploy time
-- would silently lose their in-flight transfers (the new client
-- doesn't read those rows anymore) and players would see ships
-- frozen at their departure body forever.

-- Step 1: park ships sitting on an in-flight transfer at their
-- destination body. The ship's parent_body_id swaps to the target,
-- orbit elements reset to a clean low-altitude circular orbit, and
-- epoch is bumped to current_tick so the new orbit is "fresh."
--
-- D1 (SQLite) supports correlated subqueries in UPDATE — we use one
-- per column rather than a JOIN-update (which it doesn't support).
-- The CASE on b.radius pulls a sensible parking altitude (1.5×
-- body radius) when the body row exists; falls back to 6 game units.
UPDATE game_ships
SET
  parent_body_id = (
    SELECT n.target_body_id
    FROM game_ship_nodes n
    WHERE n.ship_id = game_ships.id
      AND n.status IN ('committed', 'in_transit')
      AND n.target_body_id IS NOT NULL
    LIMIT 1
  ),
  orbit_rp = (
    SELECT COALESCE(b.radius, 4) * 1.5
    FROM game_ship_nodes n
    LEFT JOIN game_bodies b ON b.id = n.target_body_id AND b.game_id = n.game_id
    WHERE n.ship_id = game_ships.id
      AND n.status IN ('committed', 'in_transit')
      AND n.target_body_id IS NOT NULL
    LIMIT 1
  ),
  orbit_ra = (
    SELECT COALESCE(b.radius, 4) * 1.5
    FROM game_ship_nodes n
    LEFT JOIN game_bodies b ON b.id = n.target_body_id AND b.game_id = n.game_id
    WHERE n.ship_id = game_ships.id
      AND n.status IN ('committed', 'in_transit')
      AND n.target_body_id IS NOT NULL
    LIMIT 1
  ),
  orbit_omega = 0,
  orbit_m0 = 0,
  orbit_direction = 1,
  orbit_epoch = (
    SELECT g.current_tick
    FROM games g
    WHERE g.id = game_ships.game_id
  )
WHERE id IN (
  SELECT DISTINCT n.ship_id
  FROM game_ship_nodes n
  WHERE n.status IN ('committed', 'in_transit')
    AND n.target_body_id IS NOT NULL
);

-- Step 2: cancel every committed/in_transit transfer node so the
-- alarm doesn't try to re-fire or arrive-process them. We deliberately
-- DON'T delete the rows so the chronicle/history still has a record;
-- the alarm code already skips status='cancelled'.
UPDATE game_ship_nodes
SET status = 'cancelled'
WHERE status IN ('committed', 'in_transit');

-- Add a faction-level engineG column so the torch executor (both
-- client and any future server-side torch integration) can scale
-- trip times by engine research. Default matches DEFAULT_ENGINE_G
-- in src/physics/torchTransfer.ts (0.05g — research-level-0 baseline).
ALTER TABLE game_factions ADD COLUMN engine_g REAL DEFAULT 0.05;
