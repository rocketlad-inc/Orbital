-- Client crash reports.
--
-- The error boundary catches a React render crash, shows "SOMETHING
-- BROKE", and writes the trace to the player's LOCAL diagnostic log —
-- which nobody ever downloads. Two players hit React #185 three times
-- in one evening and all we had was a screenshot of the minified
-- message. This table receives what the boundary already knows: the
-- message, the JS stack, and React's component stack, with the build
-- sha so a crash can be tied to a deploy.

CREATE TABLE IF NOT EXISTS client_crashes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT,
  game_id         TEXT,
  message         TEXT NOT NULL,
  stack           TEXT,
  component_stack TEXT,
  scope           TEXT,
  url             TEXT,
  git_sha         TEXT,
  ua              TEXT,
  created_at_ms   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_client_crashes_time ON client_crashes (created_at_ms);
