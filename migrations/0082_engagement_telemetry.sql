-- Per-user engagement telemetry.
--
-- What the table could answer BEFORE this: "did user X ever open the
-- senate, and how many mutating requests did they send". That is a
-- funnel, and it was built as one — the client deduped each ui/ kind to
-- once per page load on purpose, so 85 fleet-menu rows across 8 users
-- means "8 people opened it at least once", not "it was opened 85 times".
--
-- What it could NOT answer: how often, for how long, in what order,
-- inside which visit, at what hour, and — for an action — WHAT was
-- built/researched/traded. Those are the engagement questions.
--
-- Three columns close that gap without a second table:
--
--   payload     JSON context for the event. For actions, the thing acted
--               on (building kind, tech id, ship class, trade totals).
--               STRUCTURAL ONLY — never message bodies, empire names the
--               player typed, or anything a person wrote. Telemetry that
--               quietly becomes a chat log is a liability, not a metric.
--
--   session_id  A client-generated id, one per page load. Groups a visit
--               without a sessions table: length is max-min of its rows,
--               session count is COUNT(DISTINCT session_id), and "actions
--               per visit" becomes a GROUP BY. Deriving visits from
--               timestamp gaps instead would need a heuristic idle
--               threshold that is wrong for a game with hour-long ticks.
--
--   dwell_ms    How long a screen stayed open, written when it closes.
--               "Opened the senate" and "read the senate for 90 seconds"
--               are different facts and only the second is engagement.
ALTER TABLE analytics_events ADD COLUMN payload TEXT;
ALTER TABLE analytics_events ADD COLUMN session_id TEXT;
ALTER TABLE analytics_events ADD COLUMN dwell_ms INTEGER;

-- Per-user drill-down: every "this player's timeline" query is
-- (user_id, time) ordered, and there was no index for it — the existing
-- reads are game-scoped aggregates.
CREATE INDEX IF NOT EXISTS idx_ae_user_time
  ON analytics_events(user_id, created_at_ms);

-- Session rollups: length, action count, screens visited per visit.
CREATE INDEX IF NOT EXISTS idx_ae_session
  ON analytics_events(session_id, created_at_ms);

-- Feature histograms inside one game over a window.
CREATE INDEX IF NOT EXISTS idx_ae_game_kind_time
  ON analytics_events(game_id, kind, created_at_ms);
