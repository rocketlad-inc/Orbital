-- Ship veterancy + combat history (matches src/game/combat.ts + types.ts).
--
-- Every confirmed ship kill grants the killer hull +1 rank. Each rank
-- gives +1% damage output and +1% effective max HP. Stacks
-- multiplicatively with the faction-level Weapons/Armor tech mods.
--
-- `combat_history` is a JSON blob holding the last 20 kills as
-- ShipKillRecord[]: { tick, targetName, targetClass, atBodyId }.
-- Stored as TEXT (sqlite JSON1 is available but the worker code
-- treats it as plain JSON.parse on read, JSON.stringify on write).
-- Capped client- and server-side so the column stays small.
--
-- Both columns are nullable / defaulted so existing rows backfill
-- cleanly without a migration write — fresh hulls and pre-veterancy
-- saves both read as rank=0 / history=[].

ALTER TABLE game_ships ADD COLUMN rank INTEGER NOT NULL DEFAULT 0;
ALTER TABLE game_ships ADD COLUMN combat_history TEXT;
