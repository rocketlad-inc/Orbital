-- Track the predicted Hohmann arrival tick on a maneuver node so the
-- tick resolver can separate "fired" from "arrived". Used to keep
-- in-flight ships visible (and animatable) on the canvas between
-- scheduled_t (departure burn) and arrival_at_tick (insertion burn).
-- NULL means the node hasn't fired yet, or it predates this migration.

ALTER TABLE game_ship_nodes ADD COLUMN arrival_at_tick INTEGER;
