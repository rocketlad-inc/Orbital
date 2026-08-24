-- ============================================================
-- Mega Destroyer strike charge.
--
-- The strike used to fire the instant it was ordered, on the reasoning
-- that a hull at a tenth of normal acceleration already carries its own
-- cooldown: two days to reach a neighbour, a week across the system.
-- That is true of the APPROACH and says nothing about the moment of
-- firing — a defender who saw it arrive still had no window between
-- "it is here" and "the world is gone".
--
-- 48 ticks of charge is that window. It is also the first thing in the
-- game that announces an attack before it lands, which is the whole
-- point of a weapon this size: everyone can see it winding up, and
-- everyone has two days to do something about it.
--
-- The charge lives on the SHIP rather than the target, because it is the
-- hull that is doing the work — and because a hull that moves has
-- stopped charging, which is trivial to express here and awkward
-- anywhere else.
-- ============================================================

ALTER TABLE game_ships ADD COLUMN strike_target_body_id TEXT;
ALTER TABLE game_ships ADD COLUMN strike_ready_tick INTEGER;

CREATE INDEX idx_ships_strike ON game_ships(strike_ready_tick);
