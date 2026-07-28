-- ============================================================================
-- Fleets (DESIGN-fleets.md): ships grouped under a flag captain for common
-- orders. flag_captain_id NULL = leaderless (flagship lost; player must
-- promote a member captain before the fleet takes new common orders).
-- No FK on flag_captain_id by design — captains move to the bank / are lost
-- and the fleet row must survive that transition.
-- ============================================================================
CREATE TABLE IF NOT EXISTS game_fleets (
  id               TEXT PRIMARY KEY,
  game_id          TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  faction_id       TEXT NOT NULL,
  name             TEXT NOT NULL,
  flag_captain_id  TEXT,
  created_at_tick  INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE game_ships ADD COLUMN fleet_id TEXT;
CREATE INDEX IF NOT EXISTS idx_ships_fleet ON game_ships(fleet_id);
CREATE INDEX IF NOT EXISTS idx_fleets_game ON game_fleets(game_id);
