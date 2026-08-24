-- ============================================================
-- Gravity Sink holds.
--
-- A sink catches a hull crossing it and pins it for a few ticks before
-- it can continue its burn. The hold has to be remembered on the LEG,
-- not on the ship, for two reasons:
--
--   A SHIP INSIDE THE RADIUS IS INSIDE IT EVERY TICK. Without a record
--   of having already been caught, the sink would re-trap the same hull
--   on every pass of the tick loop and nothing would ever leave.
--
--   THE HOLD DIES WITH THE LEG. Re-route and you are on a new plan; the
--   old grab should not follow you onto it. Columns on game_ship_nodes
--   are discarded with the node, which is exactly the lifetime wanted.
-- ============================================================

ALTER TABLE game_ship_nodes ADD COLUMN sink_body_id TEXT;
ALTER TABLE game_ship_nodes ADD COLUMN sink_held_until_tick INTEGER;

CREATE INDEX idx_nodes_sink ON game_ship_nodes(sink_body_id);
