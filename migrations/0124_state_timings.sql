-- /state cache and assembly telemetry.
--
-- Every player action bumps games.state_version, and every player's
-- cached /state is keyed on it — so one click anywhere throws away
-- everyone's cache and each next poll pays the full ~15-query
-- assembly. That is the leading suspect for the multi-second input lag
-- in the 700-ship game, but the only evidence was a console.log
-- (STATE-TIMING) nobody could read. This table holds a SAMPLE of /state
-- requests: whether the cache hit, how long the request took, and on a
-- miss the section marks and scene size. The per-viewer cache key (the
-- proposed fix) gets decided on these numbers, not on a hunch.

CREATE TABLE IF NOT EXISTS state_timings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id        TEXT    NOT NULL,
  faction_id     TEXT,
  hit            INTEGER NOT NULL,   -- 1 = served from the version/tick cache
  total_ms       INTEGER NOT NULL,   -- request start -> response built
  marks          TEXT,               -- STATE-TIMING section marks (miss only)
  ships          INTEGER,            -- hulls in the payload (miss only)
  state_version  INTEGER,
  created_at_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_state_timings_game_time
  ON state_timings (game_id, created_at_ms);
