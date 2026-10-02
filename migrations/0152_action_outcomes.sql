-- ============================================================
-- 0152 — did the action WORK? Outcomes, friction and first steps
--
-- Every player action has been logged at the dispatch chokepoint BEFORE
-- its handler ran, with no outcome. "Build a frigate" and "tried to build
-- a frigate, could not afford it" were the same row, so the dashboard
-- could count what people attempted but never where the game said no -
-- and a player hitting the same wall six times in a row is the single
-- clearest sign of someone who does not understand what is happening.
--
-- From here each action is logged AFTER its handler, with the HTTP
-- status, the error code the handler returned (codes only, never the
-- message text) and how long it took. Rows from before this migration
-- have NULL status and are read as "outcome unknown", never as success
-- or failure.
--
-- Two new rollups, filled by the same minute cron as 0150:
--   analytics_friction_day  rejected/failed actions per day, kind, code
--   analytics_user_first    each player's FIRST successful use of each
--                           action, the backbone of the new-player
--                           journey funnel
-- ============================================================

ALTER TABLE analytics_events ADD COLUMN status INTEGER;
ALTER TABLE analytics_events ADD COLUMN err_code TEXT;
ALTER TABLE analytics_events ADD COLUMN latency_ms INTEGER;
-- Why it was refused, for rejections only. 364 handlers answer with the
-- generic code bad_request, so the code alone cannot say why. This is
-- the SERVER'S message with names masked (worker/analytics.js
-- maskReason): digits become # and capitalised words become a dot, so
-- "not enough metal" groups together and no player-chosen name lands here.
ALTER TABLE analytics_events ADD COLUMN err_reason TEXT;

-- Rejections are a small slice of a game's events: index only them, so
-- "where did players in this game hit a wall" never scans the heartbeats.
CREATE INDEX IF NOT EXISTS idx_ae_game_rejected
  ON analytics_events(game_id, created_at_ms) WHERE status >= 400;

-- Rejected-attempt counts beside the attempt counts already there, and
-- "judged": attempts that carry an outcome at all. A refusal RATE must
-- divide by judged, not by every attempt, or for a month after this
-- ships every rate is diluted by weeks of rows that could not have been
-- refused, and reads as a reassuring near-zero.
ALTER TABLE analytics_kind_day ADD COLUMN rejected INTEGER NOT NULL DEFAULT 0;
ALTER TABLE analytics_kind_day ADD COLUMN judged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE analytics_user_day ADD COLUMN rejected INTEGER NOT NULL DEFAULT 0;
ALTER TABLE analytics_user_day ADD COLUMN judged INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS analytics_friction_day (
  day_ms  INTEGER NOT NULL,
  kind    TEXT    NOT NULL,
  code    TEXT    NOT NULL,   -- the handler's error code, or http_<status>
  reason  TEXT    NOT NULL DEFAULT '',  -- masked server message
  n       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day_ms, kind, code, reason)
);

CREATE TABLE IF NOT EXISTS analytics_user_first (
  user_id   TEXT    NOT NULL,
  kind      TEXT    NOT NULL,
  first_ms  INTEGER NOT NULL,
  n         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, kind)
);

-- Backfill first-use from history the rollup has already passed. Old
-- rows carry no outcome, so they count as uses - the best history has.
-- The cron folds in everything from the watermark on.
INSERT INTO analytics_user_first (user_id, kind, first_ms, n)
SELECT user_id, kind, MIN(created_at_ms), COUNT(*)
  FROM analytics_events
 WHERE user_id IS NOT NULL
   AND kind != 'heartbeat' AND kind NOT LIKE 'POST perf%'
   AND created_at_ms < (SELECT through_ms FROM analytics_rollup_state WHERE id = 1)
 GROUP BY user_id, kind
ON CONFLICT (user_id, kind) DO UPDATE SET
  first_ms = MIN(first_ms, excluded.first_ms),
  n = n + excluded.n;
