-- The crucible's record (worker/aiEmpire.js runSoloGame): with
-- games.ai_log = 1, every computer empire turn writes one row: what it
-- tried and was refused (tally, JSON), any error, and how long it took.
-- Off for every ordinary solo game.
ALTER TABLE games ADD COLUMN ai_log INTEGER NOT NULL DEFAULT 0;

CREATE TABLE ai_turn_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id       TEXT NOT NULL,
  faction_id    TEXT NOT NULL,
  tick          INTEGER NOT NULL,
  personality   TEXT,
  tally         TEXT,
  error         TEXT,
  ms            INTEGER,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX idx_ai_turn_log_game ON ai_turn_log(game_id, tick);
