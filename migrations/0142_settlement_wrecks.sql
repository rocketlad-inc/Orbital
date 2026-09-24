-- Wrecked settlements (Lorne, from Noah's suggestion).
--
-- A city or station beaten down in combat is WRECKED, not erased. The
-- row is already kept on death (destroyed_at_tick), buildings and all;
-- this stamp marks it as ruins somebody can take back:
--
--   SEIZE  the only faction with warships at the world pays the ordinary
--          founding price and a settlement of the same type rises on the
--          ruins under its flag -- every building one level lower, 25%
--          hull, no colony ship. The ruins are consumed; the dead row
--          stays its former owner's, which is what keeps the elimination
--          sweep honest. The same button retakes a rival's world and your
--          own lost one (and revives an eliminated empire).
--   RAZE   the same force can deny it instead: the stamp clears and the
--          row is an ordinary dead settlement again.
--
-- A wreck does not decay (Lorne). It is still a DEAD settlement to every
-- other query -- destroyed_at_tick stays set -- so it yields nothing,
-- builds nothing, fights nothing and holds no claim. Only the seize and
-- raze paths and the map read this column.
--
-- Not every death leaves ruins. An asteroid, a Mega Destroyer strike or
-- an obliterated world erases the wrecks on that world too: the gun and
-- the rock wipe a world clean; warships leave something to fight over.
ALTER TABLE game_settlements ADD COLUMN wrecked_at_tick INTEGER;

CREATE INDEX IF NOT EXISTS idx_game_settlements_wrecks
  ON game_settlements(game_id, body_id)
  WHERE wrecked_at_tick IS NOT NULL;
