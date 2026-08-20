-- ============================================================================
-- 0103 — Pre-game captain roster.
--
-- Players author their opening ten officers in the lobby: name, portrait and
-- which of the dealt traits each one carries. Stored per LOBBY MEMBER rather
-- than per faction because it is written before factions exist — the roster is
-- authored in the lobby and consumed by ensureCaptainFloor on the first tick,
-- which resolves user -> faction at that point.
--
-- One TEXT column holding a JSON array rather than ten rows or a side table:
-- the roster is read exactly once per game, always in full, never queried by
-- field, and it rides the row that already carries empire_name and bio and is
-- already locked once the game starts. A side table would add a join and a
-- second lifetime to manage for no query we will ever make.
--
-- NULL means "player never opened the step", which must keep behaving exactly
-- as it does today: ensureCaptainFloor rolls all ten at random.
-- ============================================================================

ALTER TABLE room_members ADD COLUMN captain_roster TEXT;
