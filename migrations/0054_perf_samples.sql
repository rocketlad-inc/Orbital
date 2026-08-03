-- ============================================================================
-- 0054: Client performance samples
--
-- "The UI feels unresponsive" could not be reproduced from another
-- machine: two players in the SAME game (identical payload, identical
-- server) reported completely different responsiveness, so the cost is
-- client-side and only measurable on the client that has it.
--
-- One row per sampled player action (rate-limited client-side to at most
-- one per 30s per session), carrying the click -> painted-pixels
-- breakdown plus coarse device capability so slow reports can be
-- correlated with hardware instead of guessed at.
-- ============================================================================

CREATE TABLE perf_samples (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id       TEXT,
  user_id       TEXT,
  total_ms      INTEGER NOT NULL,   -- action fired -> pixels painted
  action_ms     INTEGER NOT NULL,   -- POST round-trip
  fetch_ms      INTEGER NOT NULL,   -- /state round-trip
  map_ms        INTEGER NOT NULL,   -- JSON -> GameState (client CPU)
  paint_ms      INTEGER NOT NULL,   -- React commit + canvas redraw
  frame_ms      INTEGER NOT NULL,   -- rolling frame interval
  ships         INTEGER NOT NULL,   -- scene size at sample time
  cores         INTEGER,            -- navigator.hardwareConcurrency
  mem_gb        INTEGER,            -- navigator.deviceMemory (coarse, may be null)
  mobile        INTEGER,            -- 1 = touch/mobile UA
  ua            TEXT,               -- browser/OS string, for repro
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_perf_game ON perf_samples(game_id, created_at_ms);
CREATE INDEX idx_perf_user ON perf_samples(user_id, created_at_ms);
