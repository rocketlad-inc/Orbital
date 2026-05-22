-- Combat cadence on game_ships.
--
-- Previously the worker's per-tick combat loop in worker/room.js fired
-- every server tick (no gate). At default MP tick rate (7.5 real
-- minutes per tick) that put one volley every 7.5 minutes, but the
-- effective DPS still ran 20× faster than the SP equivalent — which
-- has always paced combat at AUTO_COMBAT_INTERVAL=20 ticks per volley.
--
-- This column lets the MP combat loop track when each ship last fired
-- so a cadence gate (currently 3 ticks, see AUTO_COMBAT_INTERVAL in
-- src/game/combat.ts) can apply consistently between SP and MP. Ships
-- that have never fired read NULL → treated as -Infinity by the
-- comparison, so the gate passes on the first eligible tick.

ALTER TABLE game_ships ADD COLUMN last_combat_tick INTEGER;
