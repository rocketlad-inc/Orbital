-- ============================================================================
-- Retroactively apply SYSTEM_SCALE = 2 to games seeded before the change.
--
-- Bodies are copied into game_bodies at seed time, so doubling the catalog
-- (worker/factions.js) only ever reached NEW games. This spreads the four
-- active 1x games out to match, so every running campaign plays on the same
-- board instead of the scale being an accident of start date.
--
-- WHAT MOVES
--   Heliocentric bodies only: orbit_radius x2, orbit_period x2^1.5, and the
--   eccentric Kuiper elements (orbit_rp/orbit_ra) x2 so they travel with the
--   orbit they describe. Exactly the transform factions.js applies to the
--   catalog, so a migrated game is indistinguishable from a fresh one.
--
-- WHAT DOESN'T
--   Moons: their orbits are parent-relative, so they ride along with their
--   planet untouched. angle0: every body keeps its current angle, so the
--   system expands in place rather than teleporting anyone to a new position
--   on its ring. soi: unscaled, matching what new games get.
--
-- SHIPS UNDER BURN
--   Server-side transit position is derived from LIVE body positions plus a
--   time fraction (worker/state.js), not a frozen trajectory, so nobody is
--   stranded by the bodies moving. But arrival_at_tick was solved for the OLD
--   distance, and leaving it would let in-flight hulls cross the new, larger
--   gap in the old time -- a free boost to whoever happened to be mid-transit.
--
--   So the remaining leg is stretched by sqrt(2): travel is T = 2*sqrt(d/a),
--   so doubling distance costs sqrt(2) time, not 2x.
--
--   Both ends are stretched around the CURRENT tick, not just the arrival.
--   Position renders as (tick - scheduled_t) / (arrival_at_tick - scheduled_t);
--   moving only the arrival grows that denominator, which would snap every
--   in-flight ship visibly BACKWARD along its path and rob players of progress
--   they had already flown. Scaling both ends about `now` holds that fraction
--   exactly where it is and lengthens only what's left.
--
-- IDEMPOTENT: targets are captured up front into a marker table keyed on the
-- 1x Earth radius (186). Re-running matches nothing, because by then Earth is
-- at 372. The marker table is also why the guard is captured BEFORE any
-- writes: a correlated guard would be re-read mid-UPDATE, against rows this
-- very statement is busy doubling.
-- ============================================================================

CREATE TABLE IF NOT EXISTS _scale2x_targets (game_id TEXT PRIMARY KEY);

INSERT OR IGNORE INTO _scale2x_targets (game_id)
SELECT b.game_id
FROM game_bodies b
WHERE b.template_id = 'earth'
  AND b.orbit_radius = 186;

-- 1) Heliocentric bodies. Parented to the game's own Sol row, so moons
--    (parented to their planet) are excluded by construction.
UPDATE game_bodies
SET orbit_radius = ROUND(orbit_radius * 2),
    orbit_period = ROUND(orbit_period * 2.8284271247461903),
    orbit_rp     = CASE WHEN orbit_rp IS NULL THEN NULL ELSE ROUND(orbit_rp * 2) END,
    orbit_ra     = CASE WHEN orbit_ra IS NULL THEN NULL ELSE ROUND(orbit_ra * 2) END
WHERE game_id IN (SELECT game_id FROM _scale2x_targets)
  AND parent_body_id IN (
    SELECT s.id FROM game_bodies s
    WHERE s.game_id = game_bodies.game_id
      AND s.template_id = 'sol'
  );

-- 2) In-flight transits: stretch both ends about the current tick by sqrt(2).
UPDATE game_ship_nodes
SET scheduled_t =
      (SELECT g.current_tick FROM games g
         JOIN game_ships s ON s.game_id = g.id
        WHERE s.id = game_ship_nodes.ship_id)
      - ((SELECT g.current_tick FROM games g
            JOIN game_ships s ON s.game_id = g.id
           WHERE s.id = game_ship_nodes.ship_id) - scheduled_t)
        * 1.4142135623730951,
    arrival_at_tick =
      (SELECT g.current_tick FROM games g
         JOIN game_ships s ON s.game_id = g.id
        WHERE s.id = game_ship_nodes.ship_id)
      + (arrival_at_tick
         - (SELECT g.current_tick FROM games g
              JOIN game_ships s ON s.game_id = g.id
             WHERE s.id = game_ship_nodes.ship_id))
        * 1.4142135623730951
WHERE target_body_id IS NOT NULL
  AND ship_id IN (
    SELECT s.id FROM game_ships s
    WHERE s.game_id IN (SELECT game_id FROM _scale2x_targets)
  )
  AND arrival_at_tick > (
    SELECT g.current_tick FROM games g
      JOIN game_ships s ON s.game_id = g.id
     WHERE s.id = game_ship_nodes.ship_id
  );

DROP TABLE _scale2x_targets;
