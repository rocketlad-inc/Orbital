-- ============================================================
-- 0177 - the profile trophy case: awards a player earned, kept per game
--
-- The end-of-game page already works out the superlatives of a finished
-- game (worker/ending.js: warmonger, ace, landlord, ...). The profile
-- shows the ones a player has earned across ALL their games, so each
-- finished game's awards are stored once, when someone first opens the
-- game's ending or the player's profile (worker/ending.js
-- recordGameAwards, worker/profileAwards.js).
--
--   game_awards        one row per (game, award): the empire that earned
--                      it, whose account it was, the number behind it,
--                      whether another empire tied it, and for the four
--                      hull awards the ship's name, class and captain.
--                      Only human empires get rows (never AI seats,
--                      monsters or observers).
--   game_awards_state  "this game has been worked out" - so a game that
--                      earned nobody anything, or one already stored, is
--                      never computed again.
--
-- Schema only and idempotent. No data statements: this is filled by the
-- app, game by game, and a migration that touched data once ran five times.
-- game_id follows the other per-game tables (cascade with the game);
-- user_id follows game_factions (a deleted account just loses the link).
-- ============================================================

CREATE TABLE IF NOT EXISTS game_awards (
  game_id         TEXT    NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  award_id        TEXT    NOT NULL,                 -- EndingAwardId
  faction_id      TEXT    NOT NULL,                 -- the empire that earned it
  user_id         TEXT    REFERENCES users(id) ON DELETE SET NULL,
  empire_name     TEXT,
  value           INTEGER NOT NULL,                 -- in the award's own unit
  tied            INTEGER NOT NULL DEFAULT 0,       -- runner-up finished level
  ship_name       TEXT,                             -- hull awards only
  ship_class      TEXT,
  captain_name    TEXT,
  won_game        INTEGER NOT NULL DEFAULT 0,       -- that empire won the game
  completed_at_ms INTEGER,                          -- when the game ended
  PRIMARY KEY (game_id, award_id)
);

CREATE INDEX IF NOT EXISTS idx_game_awards_user
  ON game_awards(user_id, completed_at_ms DESC);

CREATE TABLE IF NOT EXISTS game_awards_state (
  game_id         TEXT    PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  computed_at_ms  INTEGER NOT NULL
);
