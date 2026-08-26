-- 0119_station_orbit_clearance.sql
--
-- LIFT STATIONS THAT ARE SITTING ON THEIR WORLD.
--
-- orbit_rp is computed once, at deploy, from the body's radius. Anything
-- that changes that radius afterwards leaves the ring where it was. The
-- first game on a body_scale 2 map found the sharp edge of that: every
-- one of its five stations sits at exactly the catalogue radius + 3,
-- while the bodies themselves are twice catalogue size — so the Earth
-- station's ring lands ON Earth's limb. Reported as "why's the station
-- so close?".
--
-- The rule is the same one the deploy endpoint and the renderer now
-- share (stationOrbitRadius): three units of clearance as a floor for
-- small bodies, 22% above radius ~13.6 so a station on a star is not
-- embedded in the photosphere and still sits under its own fleet.
--
-- ONLY RAISES. A station already at or above the rule is untouched, so
-- every game whose geometry is already right sees no movement — the
-- WHERE clause is what keeps this from being a mass re-seat. Sol
-- stations pinned to 61 by 0079 satisfy the rule exactly (50 + 11) and
-- stay put.
-- ============================================================

UPDATE game_settlements
   SET orbit_rp = (SELECT b.radius + MAX(3, b.radius * 0.22)
                     FROM game_bodies b WHERE b.id = game_settlements.body_id),
       orbit_ra = (SELECT b.radius + MAX(3, b.radius * 0.22)
                     FROM game_bodies b WHERE b.id = game_settlements.body_id)
 WHERE type = 'station'
   AND orbit_rp IS NOT NULL
   AND orbit_rp < (SELECT b.radius + MAX(3, b.radius * 0.22)
                     FROM game_bodies b WHERE b.id = game_settlements.body_id);
