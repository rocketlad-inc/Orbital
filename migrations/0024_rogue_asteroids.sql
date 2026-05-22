-- Rogue asteroids — small settable bodies that can be weaponized.
--
-- Two pieces:
--
-- 1. Eccentric Kepler orbit columns on game_bodies. Existing bodies all
--    use circular orbits (orbit_radius + orbit_period only — angle is
--    linear in t). The new Kuiper-class rogue asteroids have long
--    eccentric paths that need full Kepler elements. When orbit_rp /
--    orbit_ra / orbit_omega / orbit_m0 are all present, bodyPosition
--    switches to Kepler propagation; otherwise the legacy circular
--    shortcut still applies. All defaulted to NULL so every existing
--    body keeps its current path.
--
-- 2. Ram plan columns. When a faction triggers the RAM action via the
--    Trajectory Control Thrusters building, the asteroid's natural
--    orbit is replaced by a torch transit toward another body. Plan
--    values are written here; bodyPosition's render path checks
--    ram_target_body_id and integrates the torch when present.
--    Cleared (with destroyed_at_tick set) when the impact fires.

-- Eccentric orbit columns
ALTER TABLE game_bodies ADD COLUMN orbit_rp REAL;
ALTER TABLE game_bodies ADD COLUMN orbit_ra REAL;
ALTER TABLE game_bodies ADD COLUMN orbit_omega REAL;
ALTER TABLE game_bodies ADD COLUMN orbit_m0 REAL;

-- Ram plan columns
ALTER TABLE game_bodies ADD COLUMN ram_target_body_id TEXT;
ALTER TABLE game_bodies ADD COLUMN ram_start_tick INTEGER;
ALTER TABLE game_bodies ADD COLUMN ram_flip_tick INTEGER;
ALTER TABLE game_bodies ADD COLUMN ram_arrive_tick INTEGER;
ALTER TABLE game_bodies ADD COLUMN ram_acceleration REAL;
ALTER TABLE game_bodies ADD COLUMN ram_start_pos_x REAL;
ALTER TABLE game_bodies ADD COLUMN ram_start_pos_y REAL;
ALTER TABLE game_bodies ADD COLUMN ram_start_vel_x REAL;
ALTER TABLE game_bodies ADD COLUMN ram_start_vel_y REAL;
ALTER TABLE game_bodies ADD COLUMN ram_intercept_pos_x REAL;
ALTER TABLE game_bodies ADD COLUMN ram_intercept_pos_y REAL;
ALTER TABLE game_bodies ADD COLUMN ram_total_dv REAL;
ALTER TABLE game_bodies ADD COLUMN ram_owned_by_faction_id TEXT;

-- Destruction marker — set when an asteroid's ram completes (it's
-- consumed in the impact) or in the rare case an asteroid is hit by
-- another's ram. /state filters these out.
ALTER TABLE game_bodies ADD COLUMN destroyed_at_tick INTEGER;
