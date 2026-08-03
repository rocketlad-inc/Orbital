-- ============================================================================
-- 0055: Session performance heartbeats
--
-- perf_samples (0054) measures ONE CLICK: action -> painted pixels. It says
-- nothing about how the animation feels between clicks, and it only fires
-- when a player acts — so a report of "animations are slowing down" is
-- invisible to it.
--
-- This table is the continuous view: one row per minute of active play per
-- client, carrying frame-rate distribution (not just an average — the 1%
-- low is what "choppy" actually means), the map's own draw cost, JS heap
-- size, scene complexity, and full device/GPU identity.
--
-- session_ms is the load-bearing column: charting fps against it answers
-- "does it get worse the longer you play", which is the difference between
-- a slow machine (flat line) and a leak (downward slope).
-- ============================================================================

CREATE TABLE perf_heartbeats (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id        TEXT,
  user_id        TEXT,
  session_id     TEXT NOT NULL,      -- random per page load; groups a session
  session_ms     INTEGER NOT NULL,   -- ms since this client loaded the game

  -- Frame-rate distribution over the heartbeat window (visible frames only)
  fps_avg        INTEGER NOT NULL,
  fps_low1       INTEGER NOT NULL,   -- 1% low: the stutter a player feels
  frame_p50      INTEGER NOT NULL,
  frame_p95      INTEGER NOT NULL,
  long_frames    INTEGER NOT NULL,   -- frames over 50ms in the window
  frames_seen    INTEGER NOT NULL,

  -- Map render cost, measured inside the draw call itself
  draw_p50       INTEGER NOT NULL,
  draw_p95       INTEGER NOT NULL,

  -- Memory: a climbing heap across a session is the leak signature
  heap_mb        INTEGER,
  heap_limit_mb  INTEGER,

  -- Scene complexity, so cost can be normalized against what is on screen
  ships          INTEGER NOT NULL,
  settlements    INTEGER NOT NULL,
  in_transit     INTEGER NOT NULL,
  zoom           REAL,

  -- Device identity
  gpu            TEXT,
  cores          INTEGER,
  mem_gb         INTEGER,
  dpr            REAL,
  screen_w       INTEGER,
  screen_h       INTEGER,
  mobile         INTEGER,
  ua             TEXT,

  created_at_ms  INTEGER NOT NULL
);

CREATE INDEX idx_hb_game ON perf_heartbeats(game_id, created_at_ms);
CREATE INDEX idx_hb_session ON perf_heartbeats(session_id, session_ms);
