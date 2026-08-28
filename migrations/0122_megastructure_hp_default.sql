-- Megastructures were born breached.
--
-- 0109 added `hp REAL NOT NULL DEFAULT 200` when 200 WAS full health.
-- MEGA_MAX_HP is now 3000 and the column default was never revisited,
-- while neither INSERT path (worker/room.js spawnDiscoveredGatePair,
-- worker/actions.js found-a-site) named hp — so every structure came
-- into the world at 200/3000 = 6.7%.
--
-- The seize threshold is 20% (MEGA_SEIZE_HP_FRAC), so a brand new
-- structure was ALREADY below it: "Breached — boardable by anyone
-- holding the orbit", on a gate nobody had ever shot at. Regen is 12 a
-- tick, so it took ~34 ticks just to stop being seizable and ~234 to
-- reach full. Reported on a discovered stargate sitting at 368/3000.
--
-- Both INSERTs now set hp explicitly. This heals the rows already out
-- there, narrowly: only structures that have NEVER been in combat, so
-- anything genuinely shot down keeps its damage. A structure that was
-- attacked has last_combat_tick set.
UPDATE game_megastructures
   SET hp = 3000
 WHERE hp < 3000
   AND last_combat_tick IS NULL;

-- The column DEFAULT is deliberately left alone: SQLite cannot alter a
-- default without rebuilding the table, and both writers now name hp.
-- Any future INSERT must do the same.
