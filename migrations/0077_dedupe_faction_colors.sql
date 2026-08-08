-- 0077: separate factions flying identical colours in the same game.
--
-- The mid-game rename endpoint accepted any hex with no distance check
-- (the lobby, the seeder, and the late-join path all enforce one), and
-- prod has a live pair to show for it: two factions both #ec407a. Colour
-- IS identity in the seat map, the legend, the territory bar and chat —
-- a shared colour breaks all four at once.
--
-- The endpoint is fixed in worker/factions.js alongside this migration;
-- this recolours the damage already in the data. For each exact-duplicate
-- pair the LATER-JOINED faction moves (the earlier one keeps what it has
-- always flown), taking the first candidate colour not already used in
-- its game. Candidates are palette entries, tried in order; with at most
-- one dupe pair per game in practice, one statement does the work and
-- the rest match nothing.
--
-- Idempotent structurally: every statement's WHERE requires an exact
-- duplicate to still exist, so a re-run finds nothing to change.

UPDATE game_factions SET color = '#8d6e63'
WHERE id IN (
  SELECT gf.id FROM game_factions gf
  WHERE gf.color IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM game_factions o
      WHERE o.game_id = gf.game_id AND o.id != gf.id AND o.color = gf.color
        AND (o.joined_at < gf.joined_at
             OR (o.joined_at = gf.joined_at AND o.id < gf.id))
    )
)
AND NOT EXISTS (
  SELECT 1 FROM game_factions u
  WHERE u.game_id = game_factions.game_id AND u.color = '#8d6e63'
);

UPDATE game_factions SET color = '#26c6da'
WHERE id IN (
  SELECT gf.id FROM game_factions gf
  WHERE gf.color IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM game_factions o
      WHERE o.game_id = gf.game_id AND o.id != gf.id AND o.color = gf.color
        AND (o.joined_at < gf.joined_at
             OR (o.joined_at = gf.joined_at AND o.id < gf.id))
    )
)
AND NOT EXISTS (
  SELECT 1 FROM game_factions u
  WHERE u.game_id = game_factions.game_id AND u.color = '#26c6da'
);

UPDATE game_factions SET color = '#ab47bc'
WHERE id IN (
  SELECT gf.id FROM game_factions gf
  WHERE gf.color IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM game_factions o
      WHERE o.game_id = gf.game_id AND o.id != gf.id AND o.color = gf.color
        AND (o.joined_at < gf.joined_at
             OR (o.joined_at = gf.joined_at AND o.id < gf.id))
    )
)
AND NOT EXISTS (
  SELECT 1 FROM game_factions u
  WHERE u.game_id = game_factions.game_id AND u.color = '#ab47bc'
);

UPDATE game_factions SET color = '#ff7043'
WHERE id IN (
  SELECT gf.id FROM game_factions gf
  WHERE gf.color IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM game_factions o
      WHERE o.game_id = gf.game_id AND o.id != gf.id AND o.color = gf.color
        AND (o.joined_at < gf.joined_at
             OR (o.joined_at = gf.joined_at AND o.id < gf.id))
    )
)
AND NOT EXISTS (
  SELECT 1 FROM game_factions u
  WHERE u.game_id = game_factions.game_id AND u.color = '#ff7043'
);
