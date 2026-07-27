-- Tighter park orbits: ships now park at body radius + 2 (was +4), which
-- read as "twice the planet's disc away" and crowded moon lanes in busy
-- systems. New spawns/arrivals get the tight orbit from the code; this
-- pulls EXISTING parked fleets in too. Only ever shrinks (never widens a
-- tighter orbit), and skips ships whose parent body row is missing.
-- Transiting ships are included harmlessly — their orbit is rewritten on
-- arrival anyway.
UPDATE game_ships SET
  orbit_rp = (SELECT COALESCE(b.radius, 4) + 2 FROM game_bodies b WHERE b.id = game_ships.parent_body_id),
  orbit_ra = (SELECT COALESCE(b.radius, 4) + 2 FROM game_bodies b WHERE b.id = game_ships.parent_body_id)
WHERE status = 'active'
  AND EXISTS (SELECT 1 FROM game_bodies b WHERE b.id = game_ships.parent_body_id)
  AND orbit_rp > (SELECT COALESCE(b.radius, 4) + 2 FROM game_bodies b WHERE b.id = game_ships.parent_body_id);
