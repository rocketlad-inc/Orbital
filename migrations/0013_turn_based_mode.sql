-- Turn-Based Mode (MP, prototype).
--
-- Adds two game-level config columns + a per-faction commit ledger. When
-- a game has `turn_based_enabled = 1`, the Room DO's wall-clock alarm
-- stops auto-advancing the tick; instead the tick batch fires from
-- POST /api/games/:gameId/turn/commit once every faction has committed
-- the current turn.
--
-- The `current_turn_number` lives on `games` so a player's commit ledger
-- entry maps unambiguously back to "which turn this was for", even if
-- two players double-click in the same millisecond. After a successful
-- batch the worker increments `current_turn_number` and clears any
-- now-stale `game_turn_commits` rows.

ALTER TABLE games ADD COLUMN turn_based_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE games ADD COLUMN ticks_per_turn INTEGER NOT NULL DEFAULT 20;
ALTER TABLE games ADD COLUMN current_turn_number INTEGER NOT NULL DEFAULT 0;

-- One row per (game, faction, turn) pair recording when that faction
-- declared themselves ready to advance. Composite PK doubles as the
-- "already committed?" idempotency guard so a double-tap on the COMMIT
-- TURN button can't double-fire the batch.
CREATE TABLE IF NOT EXISTS game_turn_commits (
  game_id         TEXT    NOT NULL,
  faction_id      TEXT    NOT NULL,
  turn_number     INTEGER NOT NULL,
  committed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (game_id, faction_id, turn_number)
);

CREATE INDEX IF NOT EXISTS idx_turn_commits_game_turn
  ON game_turn_commits(game_id, turn_number);
