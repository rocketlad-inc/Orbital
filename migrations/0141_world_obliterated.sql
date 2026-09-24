-- A world a Mega Destroyer has destroyed outright.
--
-- The strike used to have one effect: strip the biosphere. It now has
-- two, chosen by the state of the world when the order is given:
--
--   a LIVING (terraformed) world is sterilised, as before;
--   a RAW world -- never terraformed, or already sterilised -- is
--   obliterated.
--
-- So a living world takes two strikes and a raw one takes one (Lorne).
--
-- AN OBLITERATED WORLD STAYS ON THE MAP. The row is not retired
-- (destroyed_at_tick) and its type is not changed: its moons, its
-- structures and the ships parked on it keep orbiting exactly where
-- they were, around a debris field. Retiring the row would orphan every
-- moon, and changing the type would regroup the systems (Jupiter's
-- type is what makes the Jovian moons one system). Only the WORLD COUNT
-- changes: domination, the senate, the roster and the watch all stop
-- counting it, which lowers every goalpost that is a share of the map.
ALTER TABLE game_bodies ADD COLUMN obliterated_at_tick INTEGER;

-- What the charging strike will DO, fixed when it was ordered. The world
-- can change under a 24-tick charge -- a rival strips it first, or a
-- terraforming finishes -- and a hull ordered to sterilise must not
-- fire an obliteration nobody chose. A strike whose mode no longer
-- matches the world stands down instead. NULL on a hull armed before
-- this column existed means 'sterilise', the only mode there was.
ALTER TABLE game_ships ADD COLUMN strike_mode TEXT;
