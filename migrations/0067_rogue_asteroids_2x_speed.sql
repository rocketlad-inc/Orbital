-- 0067_rogue_asteroids_2x_speed.sql
--
-- Rogue asteroids now orbit at 2x the speed of a planet at the same
-- distance (Lorne). worker/factions.js halves their catalogue periods so
-- NEW games seed fast; this brings the 48 rocks already in flight across
-- the 8 live games along with them.
--
-- Halving orbit_period doubles angular rate everywhere, because every
-- consumer derives motion from that one field: the client's bodyPosition,
-- the server's transfer-intercept solver (room.js), and the Kepler path
-- the eccentric Kuiper trio (Black Sky, Vagrant, Augustín) uses. Nothing
-- caches a derived angular velocity.
--
-- RELATIVE, not absolute: the seeder scales catalogue periods by ~2.83 on
-- insert, so live rows read 1485..18837 where the catalogue says
-- 525..6660. Dividing in place is correct whatever that factor is, and
-- also survives a body whose orbit was altered by a Trajectory Control
-- Thruster ram.
--
-- SCOPE is type = 'asteroid' — exactly the six rogues per game. The belt
-- rocks (Ceres, Vesta, Pallas, Hygiea, Juno) are type = 'dwarf' and keep
-- planet-normal speed; they're a stationary resource field, not a chase.
--
-- IDEMPOTENT via a marker column: re-running matches zero rows, so a
-- retry after a mid-migration 500 (which does NOT stamp _migrations)
-- can't halve a second time and leave the rocks at 4x.

ALTER TABLE game_bodies ADD COLUMN rogue_2x INTEGER NOT NULL DEFAULT 0;

UPDATE game_bodies
   SET orbit_period = orbit_period / 2.0,
       rogue_2x = 1
 WHERE rogue_2x = 0
   AND type = 'asteroid'
   AND orbit_period > 0;
