-- ============================================================================
-- 0052: Admin analytics telemetry
--
-- Three additions, all write-cheap and read-rarely (only the admin
-- dashboard queries them):
--
-- 1. faction_metrics — one row per (game, tick, faction) recorded at the
--    end of resolveTick. This is the yield-curve source: game_factions
--    only holds CURRENT resources, so without a per-tick record there is
--    no history to chart. Rows are ~40 bytes; a 4000-tick 8-faction game
--    tops out around 32k rows, well inside D1 comfort.
--
-- 2. analytics_events — one row per mutating player action (POST/PATCH/
--    DELETE under /api/games/…), kind = normalized route ("ships/orders",
--    "fleets", "build-queue"…). Answers "which features get used".
--
-- 3. sessions.last_seen_at — touched (throttled to ~1/min) by the /state
--    poll, so (last_seen_at − created_at) approximates session length
--    and MAX(last_seen_at) gives true last-activity, which
--    users.last_login_at cannot (sessions live for weeks).
-- ============================================================================

CREATE TABLE faction_metrics (
  game_id      TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  tick_number  INTEGER NOT NULL,
  faction_id   TEXT NOT NULL,
  metal        INTEGER NOT NULL DEFAULT 0,
  fuel         INTEGER NOT NULL DEFAULT 0,
  gold         INTEGER NOT NULL DEFAULT 0,
  science      INTEGER NOT NULL DEFAULT 0,
  ships        INTEGER NOT NULL DEFAULT 0,
  settlements  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, tick_number, faction_id)
);

CREATE TABLE analytics_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id       TEXT,
  user_id       TEXT,
  kind          TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_analytics_events_game ON analytics_events(game_id, created_at_ms);
CREATE INDEX idx_analytics_events_user ON analytics_events(user_id, created_at_ms);

ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;
