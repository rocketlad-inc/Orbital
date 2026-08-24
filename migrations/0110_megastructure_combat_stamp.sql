-- ============================================================
-- Weapons Stations were shooting invisibly.
--
-- The megastructure fire pass applied damage and did nothing else: no
-- roll to hit, no entry in the battle record, and — because there was
-- nowhere to write it — no stamp saying the thing had fired. Ships and
-- settlements both carry last_combat_tick / last_target_id, which is
-- what the client's combat FX reads to draw a tracer from a shooter to
-- what it is actually shooting at.
--
-- Without these two columns a station could kill a destroyer in the open
-- and the only evidence anywhere in the game was the destroyer being
-- gone. The player who built the station saw nothing, and the player who
-- lost the hull had no way to learn what killed it.
--
-- Same two column names as game_ships and game_settlements on purpose:
-- the FX layer already understands that pair, and a third spelling of
-- "who did I last shoot" is how the mirrors in this codebase drift.
-- ============================================================

ALTER TABLE game_megastructures ADD COLUMN last_combat_tick INTEGER;
ALTER TABLE game_megastructures ADD COLUMN last_target_id TEXT;
