-- Captains (DESIGN-captains.md): a named, persistent officer attached to
-- every ship. Captains OWN veterancy (rank/combat_history move here); a
-- ship with no captain performs at rank 0. Backfill is lazy in the tick
-- pass (worker/captains.js ensureCaptains) — every active ship across
-- EVERY faction gets a captain minted inheriting the ship's rank, so no
-- live game loses veterancy and rival aces aren't stealth-nerfed.
CREATE TABLE IF NOT EXISTS game_captains (
  id               TEXT PRIMARY KEY,
  game_id          TEXT NOT NULL,
  faction_id       TEXT NOT NULL,
  name             TEXT NOT NULL,
  avatar_id        TEXT,                 -- code-shipped SVG id ('a1'..'a12')
  bio              TEXT,                 -- auto-generated, player-editable
  rank             INTEGER NOT NULL DEFAULT 0,
  combat_history   TEXT,                 -- JSON kill records (LRU, moved off ship)
  traits_json      TEXT,                 -- JSON array of trait ids
  ship_id          TEXT,                 -- NULL = in the bank, unassigned
  status           TEXT NOT NULL DEFAULT 'active',  -- active | lost
  created_at_tick  INTEGER NOT NULL DEFAULT 0,
  lost_at_tick     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_captains_game_faction ON game_captains (game_id, faction_id);
CREATE INDEX IF NOT EXISTS idx_captains_ship ON game_captains (ship_id);

-- Ship -> captain pointer. game_ships.rank/combat_history become
-- read-only legacy after backfill (kept one release for rollback).
ALTER TABLE game_ships ADD COLUMN captain_id TEXT;
