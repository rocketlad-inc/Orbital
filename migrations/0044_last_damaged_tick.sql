-- Battle-damage FX: when did this hull/settlement last TAKE damage?
-- Distinct from last_combat_tick (when it FIRED — that column gates the
-- return-fire cadence and must not be stamped on being hit; see the
-- warning in worker/state.js). The client renders persistent fire/smoke
-- on anything damaged within the last tick, so "damage was taken" reads
-- at a glance instead of relying on a split-second flash at the tick.
ALTER TABLE game_ships ADD COLUMN last_damaged_tick INTEGER;
ALTER TABLE game_settlements ADD COLUMN last_damaged_tick INTEGER;
