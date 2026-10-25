-- Play for Free (worker/trial.js, Lorne 2026-10-24): a visitor plays a
-- trial solo game on a SHADOW account, with no sign-up, and saves it later.
--   users.shadow            0 a real account; 1 an unsaved trial account;
--                           2 a trial account since merged into a real one
--   users.shadow_claimed_ms when it was saved (merged)
--   games.trial             1 for a trial game (2 rivals, 30 s ticks)
--   games.host_seen_ms      the trial player's last /state, once a minute
--   games.auto_paused       1 when the idle sweep paused it (resumes on return)
--   trial_starts            one row per trial started, per hashed IP, for
--                           the rate limit
ALTER TABLE users ADD COLUMN shadow INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN shadow_claimed_ms INTEGER;
ALTER TABLE games ADD COLUMN trial INTEGER NOT NULL DEFAULT 0;
ALTER TABLE games ADD COLUMN host_seen_ms INTEGER;
ALTER TABLE games ADD COLUMN auto_paused INTEGER NOT NULL DEFAULT 0;

CREATE TABLE trial_starts (
  ip_hash       TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX idx_trial_starts_ip ON trial_starts(ip_hash, created_at_ms);
