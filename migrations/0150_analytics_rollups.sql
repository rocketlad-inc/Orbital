-- ============================================================
-- 0150 — analytics rollups: the admin dashboard stops re-reading history
--
-- Every overview load re-counted the whole analytics_events table from
-- scratch: 632,550 rows read per load on 2026-09-28 with 163 accounts,
-- refreshed every 30 seconds while the tab was open. The table grows by
-- one heartbeat per player per minute, so that cost grows with players
-- TIMES history, and at a few thousand players a single load would read
-- tens of millions of rows.
--
-- The fix is to read each event ONCE. A minute cron (worker/analytics.js
-- rollupAnalytics) folds the newest slice of events into the small
-- tables below and advances a watermark. The dashboard reads only these.
--
--   analytics_user_day   one row per (UTC day, player, game)
--   analytics_heat       global play-minutes per UTC hour (real players)
--   analytics_kind_day   global action counts per (UTC day, action kind)
--   analytics_user_seen  one row per player - first and last heartbeat
--   analytics_game_seen  one row per game - last real heartbeat and action
--   analytics_rollup_state  the watermark (single row, id = 1)
--
-- Nothing here is authoritative. Every row is derived from
-- analytics_events and can be rebuilt by deleting the rollup rows and
-- resetting through_ms to 0 - the cron starts again from the first event.
-- ============================================================

-- The rollup reads events by time alone. Every existing index leads with
-- game, user or session, so a pure time range was a full scan.
CREATE INDEX IF NOT EXISTS idx_ae_time ON analytics_events(created_at_ms);

-- Exact duplicate of idx_analytics_events_user (0052), added again in
-- 0082 under a new name. Every heartbeat insert paid to maintain both.
DROP INDEX IF EXISTS idx_ae_user_time;

CREATE TABLE IF NOT EXISTS analytics_user_day (
  day_ms          INTEGER NOT NULL,          -- UTC midnight
  user_id         TEXT    NOT NULL,
  game_id         TEXT    NOT NULL DEFAULT '', -- '' = not in a game
  minutes         INTEGER NOT NULL DEFAULT 0,  -- heartbeats = active minutes
  actions         INTEGER NOT NULL DEFAULT 0,
  last_beat_ms    INTEGER,
  last_action_ms  INTEGER,
  qa              INTEGER NOT NULL DEFAULT 0,  -- robot/test account, stamped at rollup
  PRIMARY KEY (day_ms, user_id, game_id)
);
CREATE INDEX IF NOT EXISTS idx_aud_user ON analytics_user_day(user_id, day_ms);
CREATE INDEX IF NOT EXISTS idx_aud_game ON analytics_user_day(game_id, day_ms);

CREATE TABLE IF NOT EXISTS analytics_heat (
  hour_ms  INTEGER PRIMARY KEY,             -- UTC hour start
  minutes  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS analytics_kind_day (
  day_ms  INTEGER NOT NULL,
  kind    TEXT    NOT NULL,
  n       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day_ms, kind)
);

CREATE TABLE IF NOT EXISTS analytics_user_seen (
  user_id        TEXT PRIMARY KEY,
  first_beat_ms  INTEGER,
  last_beat_ms   INTEGER,
  minutes        INTEGER NOT NULL DEFAULT 0
);

-- One row per game, all time. "When did a real person last touch this
-- game" is what sorts and triages the games list, and it must not cost a
-- scan of the game's whole history to answer.
CREATE TABLE IF NOT EXISTS analytics_game_seen (
  game_id         TEXT PRIMARY KEY,
  last_beat_ms    INTEGER,
  last_action_ms  INTEGER
);

CREATE TABLE IF NOT EXISTS analytics_rollup_state (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  through_ms  INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO analytics_rollup_state (id, through_ms) VALUES (1, 0);
