-- ============================================================
-- 0148 — the game that opens when you launch Orbital
--
-- Launch used to drop a player straight into whichever room they had
-- last visited (and, failing that, their only live game), so someone
-- playing two games had to back out of one every time to reach the
-- other. Now launch lands on the lobby unless the player switched
-- Auto-load on for a game; this is that choice, on the ACCOUNT so it
-- follows them from browser to phone app. NULL = land on the lobby.
--
-- Not a foreign key: a deleted room just stops matching a membership
-- at launch and is cleared there, the same way the old device-only
-- pin was.
-- ============================================================

ALTER TABLE users ADD COLUMN autoload_room_id TEXT;
