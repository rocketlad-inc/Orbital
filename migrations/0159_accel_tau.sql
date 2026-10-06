-- ============================================================
-- 0159 — the build-up grows exponentially
--
-- 0158 made a ship's push build from 0.05g to 1g over 48 ticks of burning,
-- in a straight line. Moon hops came out too fast (Io-Callisto ~10h ->
-- ~5.5h), so the same build now grows EXPONENTIALLY: the push doubles
-- about every 11 ticks, barely moving at first and climbing steeply late,
-- and still reaches 1g at 48 ticks (worker/burn.js GROWTH_TAU). Lorne,
-- 2026-10-06: "starts muuuuch slower but leads to the same result".
--
-- accel_tau is the ticks for the push to grow by a factor of e, recorded
-- with the rest of the launch plan so the server's integrator and every
-- client fly the leg that was planned. A leg carries accel_tau OR the
-- linear accel_ramp, never both; with neither it is a flat push.
-- ============================================================

ALTER TABLE game_ship_nodes ADD COLUMN accel_tau REAL;
