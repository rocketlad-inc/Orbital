-- ============================================================================
-- 0028 — Fractional yield remainders for per-tick collector delivery
-- ============================================================================
--
-- Settlements with hasCollector=1 now deliver their harvest yield directly
-- to the faction pool every tick, at a fractional rate of (yield /
-- SETTLEMENT_HARVEST_INTERVAL) per resource.
--
-- Faction-pool columns (metal/fuel/gold/science) are INTEGER, so we can't
-- store fractional cents there directly. These remainder columns accumulate
-- the sub-1 portion of each tick's delivery; when the remainder crosses 1,
-- the integer portion transfers to the pool and the residual stays here.
--
-- All four DEFAULT 0 so existing factions get a clean starting state
-- without any backfill.
-- ============================================================================

ALTER TABLE game_factions ADD COLUMN fuel_remainder    REAL NOT NULL DEFAULT 0;
ALTER TABLE game_factions ADD COLUMN metal_remainder   REAL NOT NULL DEFAULT 0;
ALTER TABLE game_factions ADD COLUMN gold_remainder    REAL NOT NULL DEFAULT 0;
ALTER TABLE game_factions ADD COLUMN science_remainder REAL NOT NULL DEFAULT 0;
