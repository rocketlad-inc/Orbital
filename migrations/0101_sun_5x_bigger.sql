-- Sol grows 5x: radius 10 -> 50.
--
-- radius is NOT touched by SYSTEM_SCALE (that scales orbit_radius /
-- orbit_period / orbit_rp / orbit_ra for heliocentric bodies and skips Sol
-- entirely), so a flat 50 is correct for scaled and unscaled games alike.
--
-- Mercury, the innermost body, orbits at 72 pre-scale / 144 post-scale, so
-- it clears a radius-50 star in every game.
--
-- The dangerous part is not the star, it is everything already parked at it.
-- Ships park at parkOrbitRadius() = 1.3x radius = 65, stations at 1.22x = 61.
-- Anything sitting at the OLD altitudes (ships at 12, the odd rescued hull
-- at 18/20, stations at 13) is now inside the photosphere. Lift them.

UPDATE game_bodies
   SET radius = 50
 WHERE template_id = 'sol'
   AND radius <> 50;

-- Ships: any hull whose parent is Sol and which is below the new park
-- altitude. rp = ra keeps the orbit circular and orbit_m0 is untouched, so
-- each ship keeps its bearing and simply moves outward.
UPDATE game_ships
   SET orbit_rp = 65,
       orbit_ra = 65
 WHERE orbit_rp IS NOT NULL
   AND orbit_rp < 65
   AND parent_body_id IN (
     SELECT id FROM game_bodies WHERE template_id = 'sol'
   );

-- Stations orbiting Sol (the Dyson foundation is one). Cities cannot exist
-- here -- canHostCity is terrestrial|moon|dwarf -- but the orbit_rp NOT NULL
-- test excludes surface placements regardless.
UPDATE game_settlements
   SET orbit_rp = 61,
       orbit_ra = 61
 WHERE orbit_rp IS NOT NULL
   AND orbit_rp < 61
   AND body_id IN (
     SELECT id FROM game_bodies WHERE template_id = 'sol'
   );
