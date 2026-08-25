-- ============================================================
-- The hull's rank sheet is torn up for good.
--
-- Migration 0068 made veterancy CAPTAIN-ONLY and ZEROED
-- game_ships.rank / game_ships.combat_history. It stopped short of
-- dropping them, and that half-measure is exactly the trap it warned
-- about: two columns with plausible names, live-looking, sitting under
-- a rule that says they must never be read. Since then the ship spawn
-- went on writing `rank` (always 0) into every new hull, purely because
-- the column was there to write to.
--
-- Lorne, 2026-08-25: "The only source of Rank and EXP should be a
-- captain/admiral." So they go.
--
-- SAFE TO DROP — verified before writing this, not assumed:
--   * No reader. Every rank read in the worker is COALESCE(c.rank, 0)
--     off game_captains; the remaining `s.rank` hits in room.js are
--     comments explaining this rule.
--   * No writer. The build-completion INSERT was the last one and is
--     removed in the same change.
--   * No index. game_ships carries six indexes, none of which mentions
--     either column, so SQLite's DROP COLUMN restrictions don't bite.
--
-- The kill HISTORY these columns held was already discarded by 0068;
-- the chronicle remains the permanent record of who killed what.
-- ============================================================

ALTER TABLE game_ships DROP COLUMN rank;
ALTER TABLE game_ships DROP COLUMN combat_history;
