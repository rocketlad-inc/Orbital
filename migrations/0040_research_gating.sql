-- 0040_research_gating.sql
--
-- Research-gated feature rollout. Every mechanic beyond the starting kit
-- (1 corvette + 1 colony ship + your capital) now sits behind a research
-- level — see src/game/researchUnlocks.ts for the tree.
--
-- gating_enabled is the grandfather switch:
--   0  pre-existing games. Every feature stays unlocked regardless of
--      research, so a match already in progress is completely unaffected.
--      This is why the DEFAULT is 0 and why seedGameWorld sets it to 1
--      explicitly for new games rather than relying on the default.
--   1  new games. Features gate on research level.
--
-- Deliberately NOT a backfill of faction_techs: retroactively "granting"
-- live factions the levels matching what they've already built would be
-- guesswork, and any mistake silently removes a feature a player is
-- mid-way through using. A per-game switch is exact.

ALTER TABLE games ADD COLUMN gating_enabled INTEGER NOT NULL DEFAULT 0;
