-- ============================================================
-- 0088 — the server owns the trajectory (DESIGN-transit-combat.md, stage 0)
--
-- Today game_ship_nodes stores anchors and tick numbers — no position,
-- no velocity. Only the client knows where a ship is mid-flight, because
-- only the client builds the torch plan. That is fine while transit is
-- combat-proof, and fatal the moment it isn't: if the server re-derived
-- arcs independently there would be two derivations of one truth, and
-- shots would come from where the client does not draw the ship. That is
-- the exact bug class that cost three attempts in the aiming code (map
-- drawn with one camera, hit-tested with another).
--
-- So the launch plan is stamped onto the node, immutable, at departure:
-- where the burn started, the velocity it inherited, the acceleration,
-- and when it flips to braking. Position becomes a PURE FUNCTION OF TICK
-- — no per-tick writes, replay-safe — and /state ships the same plan so
-- the client renders the server's arc rather than its own.
--
-- Additive, no backfill, all columns nullable ON PURPOSE: a node without
-- a plan is from before this flag existed and simply does not participate
-- in transit combat. Ships already in flight when this deploys keep their
-- client-drawn arcs and their immunity until they next depart.
-- ============================================================

ALTER TABLE game_ship_nodes ADD COLUMN launch_x   REAL;
ALTER TABLE game_ship_nodes ADD COLUMN launch_y   REAL;
ALTER TABLE game_ship_nodes ADD COLUMN launch_vx  REAL;
ALTER TABLE game_ship_nodes ADD COLUMN launch_vy  REAL;

-- units/tick², from engine_g × parts × tech at the moment of departure.
-- Snapshotted rather than re-derived so a tech completing mid-flight
-- cannot retroactively bend an arc the player already committed to.
ALTER TABLE game_ship_nodes ADD COLUMN accel      REAL;

-- The tick (fractional) at which the brachistochrone stops accelerating
-- and starts braking. With launch state + accel this closes the plan:
-- position at any tick is one piecewise-quadratic evaluation.
ALTER TABLE game_ship_nodes ADD COLUMN flip_tick  REAL;
