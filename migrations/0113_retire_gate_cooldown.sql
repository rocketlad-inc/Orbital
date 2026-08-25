-- ============================================================
-- The gate cooldown is retired before it ever really worked.
--
-- 0112 gave gates a recharge between transits. That was my reading of
-- "some time between transits" and it was the wrong one: Lorne wants the
-- gate to FLING the ship — a crossing that would take ten ticks under
-- your own engines takes three — rather than to sit idle afterwards.
--
-- The compressed flight is the better mechanic by some distance. A hull
-- in transit is visible, interceptable, and catchable by a Gravity Sink,
-- so a gate now plugs into every system the game already has instead of
-- sidestepping them with an instant hop and a timer. A cooldown on top
-- would be taxing the same crossing twice.
--
-- Dropped rather than left in place: an unused column with a plausible
-- name is a trap for whoever reads this schema next.
-- ============================================================

ALTER TABLE game_megastructures DROP COLUMN transit_cooldown_until_tick;
