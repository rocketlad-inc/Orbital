-- ============================================================================
-- 0054 — Fleet economy: upkeep/arrears, rush construction, refit propagation
-- (DESIGN-fleet-economy §1 §2 §3)
-- ============================================================================
--
-- Upkeep (§1): every active hull bills per-tick maintenance (corvette 0.25c,
-- frigate 1c+1m, destroyer 2c+2m, freighter 1c). Faction pools are INTEGER,
-- so fractional bills accumulate in the carry columns until a whole unit is
-- due (same trick as 0028's yield remainders, in reverse). What a faction
-- CAN'T pay lands in the arrears columns; any positive arrears = the whole
-- fleet fights at 75% damage until the debt clears. Arrears never destroys
-- ships and repays automatically from the next tick's income.
ALTER TABLE game_factions ADD COLUMN upkeep_carry_gold  REAL NOT NULL DEFAULT 0;
ALTER TABLE game_factions ADD COLUMN upkeep_carry_metal REAL NOT NULL DEFAULT 0;
ALTER TABLE game_factions ADD COLUMN arrears_gold       REAL NOT NULL DEFAULT 0;
ALTER TABLE game_factions ADD COLUMN arrears_metal      REAL NOT NULL DEFAULT 0;

-- Rush (§3): pay the ship's full price again to halve REMAINING build time.
-- Unlimited rushes per order; each one carries a 25% chance the hull is
-- delivered at half health. The roll happens at rush time (server-side) and
-- is sticky — a botched order can't get worse, and can't be un-botched.
ALTER TABLE game_body_build_queue ADD COLUMN rush_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE game_body_build_queue ADD COLUMN botched    INTEGER NOT NULL DEFAULT 0;

-- Refit (§2): saving a template change can propagate to live hulls for a fee
-- (half the parts-price delta per ship). Ships at a friendly shipyard refit
-- immediately; everyone else carries the design id here and refits (and is
-- charged) on next arrival at a friendly yard — see the arrival pass hook.
ALTER TABLE game_ships ADD COLUMN refit_pending_design_id TEXT;
