-- 0121_deploy_on_arrival.sql
--
-- A COLONY SHIP THAT SETTLES WHEN IT GETS THERE.
--
-- Sending a colony ship somewhere and founding a station were two acts
-- separated by however long the flight takes — which on a one-hour tick
-- means going to bed with a hull in transit and settling it tomorrow.
-- The same overnight problem build orders exist for, one step further
-- along: the order that survives the BUILD did not survive the FLIGHT.
--
-- NULL is every ship today and means "arrive and wait", so nothing
-- changes for a hull already in the air.
-- ============================================================

ALTER TABLE game_ships ADD COLUMN deploy_on_arrival TEXT;
