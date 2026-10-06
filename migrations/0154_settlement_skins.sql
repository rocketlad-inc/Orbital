-- ============================================================
-- 0154 — colony and station skins (a Commander's Commission look)
--
-- How an empire's cities and orbital stations are drawn: the free look
-- (towers / hub) or one of four premium styles each. Purely cosmetic:
-- the skin restyles habitat towers, the landing pad and the station hub,
-- and NEVER the buildings and modules a rival reads levels from.
--
-- Chosen in two places, the same split as emblems:
--   users.*_skin          the account default (Profile -> Hangar), used in
--                         every game the player has not overridden
--   room_members.*_skin   a per-game override (the lobby flag section)
--
-- Resolved when the game state is READ (worker/state.js), not copied into
-- game_factions at seed: override, else account default, and only while
-- the player holds the Commission. So a new default restyles running
-- games, and a refunded Commission falls back to the free look by itself.
-- NULL everywhere means the free look.
-- ============================================================

ALTER TABLE users ADD COLUMN city_skin TEXT;
ALTER TABLE users ADD COLUMN station_skin TEXT;
ALTER TABLE room_members ADD COLUMN city_skin TEXT;
ALTER TABLE room_members ADD COLUMN station_skin TEXT;
