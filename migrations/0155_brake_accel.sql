-- ============================================================
-- 0155 — a separate braking thrust on every leg
--
-- Ships push toward their target, flip, and brake. Until now the brake
-- ran at the same thrust as the push, so the flip always fell at the
-- midpoint. From 2026-10-06 the brake is nine times harder (worker/
-- burn.js BRAKE_MUL), which moves the flip to 90% of the trip and cuts
-- every trip to 0.745x — alongside the base push rising 0.05g -> 1g.
--
-- brake_accel is that braking thrust, recorded at commit with the rest
-- of the launch plan (0088), because the server's transit-combat
-- integrator and every client must fly the leg the planner planned.
--
-- NULL means an even burn that brakes at `accel`: every leg committed
-- before this, every older bundle, and the asteroid ram. Nothing in
-- flight changes course when this lands.
-- ============================================================

ALTER TABLE game_ship_nodes ADD COLUMN brake_accel REAL;
