-- 0120_yard_default_order.sql
--
-- WHAT THE YARD IS DOING, so a queued hull can follow it.
--
-- ON COMPLETION was a property of the open panel: client state, copied
-- into each build row at queue time and forgotten when the menu closed.
-- That made it useless as something to DEFER to — a row saying "same as
-- the station" would have had nothing to read an hour later.
--
-- Stored on the station it becomes a real setting. The cascade at
-- roll-out is:
--
--   row build_order set        -> that
--   row build_order NULL       -> the yard's default
--   yard default NULL          -> wait at the yard
--
-- Which is why this is safe under running games: every existing row and
-- every yard start NULL, so every hull resolves exactly as it does today
-- until somebody sets a default.
--
-- 'stay' is the new verb that goes with it — an explicit "this one waits
-- here" that a row needs once its yard has an opinion.
-- ============================================================

ALTER TABLE game_settlements ADD COLUMN default_build_order TEXT;
ALTER TABLE game_settlements ADD COLUMN default_build_order_body_id TEXT;
ALTER TABLE game_settlements ADD COLUMN default_build_order_route_id TEXT;
ALTER TABLE game_settlements ADD COLUMN default_build_order_fleet_id TEXT;
