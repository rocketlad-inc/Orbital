-- THE THREE BODY EVENT, rewritten (worker/invasion.js): the science blight
-- now comes from an EMITTER, a hidden structure orbiting an outer planet.
--
--   emitter_body_id        the structure's body
--   found_by_faction_id    who first saw it (null if the reveal timer did)
--   activated_tick         the tick it was discovered and switched on; the
--                          blight starts here and the fleet leaves 24
--                          ticks later
--   emitter_destroyed_tick the tick it was destroyed; the blight ends here

ALTER TABLE game_invasion ADD COLUMN emitter_body_id TEXT;
ALTER TABLE game_invasion ADD COLUMN found_by_faction_id TEXT;
ALTER TABLE game_invasion ADD COLUMN activated_tick INTEGER;
ALTER TABLE game_invasion ADD COLUMN emitter_destroyed_tick INTEGER;
