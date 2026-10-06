-- ============================================================
-- 0158 — the push builds over a burn
--
-- A ship lights its engine at 0.05g and the push grows the longer it
-- burns, to 1g after 48 ticks (worker/burn.js), then brakes at 9x the
-- push it reached (brake_accel, 0155). Short hops fly much as they did;
-- long outer hauls spend most of their burn near the top. Lorne,
-- 2026-10-06: "build from launch. Easier to explain".
--
-- Recorded at commit with the rest of the launch plan (0088), because
-- the server's transit-combat integrator and every client have to fly
-- the leg the planner planned:
--   accel        the push at launch (as before)
--   accel_ramp   units/tick^3 added to the push per tick of burning
--   accel_max    where the build tops out
--
-- NULL = a flat push: every leg committed before this, older bundles,
-- gate hops and the asteroid ram. Nothing in flight changes course.
-- ============================================================

ALTER TABLE game_ship_nodes ADD COLUMN accel_ramp REAL;
ALTER TABLE game_ship_nodes ADD COLUMN accel_max REAL;
