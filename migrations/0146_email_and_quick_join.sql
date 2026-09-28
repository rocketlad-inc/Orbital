-- ============================================================
-- 0146 — email, password reset, and Quick Join
--
-- EMAIL PREFERENCES live on the user, two switches, NULL = the default
-- (on). Two and only two because email is not a fourth copy of every
-- phone alert: it carries the daily Herald and the start/end of games.
-- Account mail (password reset, welcome) has no switch.
--
-- email_log is the NEVER-TWICE ledger, same rule as notification_log:
-- every send names the event it reports, and the unique index makes a
-- repeat impossible. No addresses or bodies are stored here.
--
-- password_resets holds the SHA-256 of each reset token, never the
-- token. One hour, one use.
--
-- rooms.quick_join marks a room made by the Quick Join button. Those
-- start themselves the moment the last seat fills, because nobody in
-- a room of strangers is waiting by the lobby to press START.
-- ============================================================

ALTER TABLE users ADD COLUMN email_herald INTEGER;
ALTER TABLE users ADD COLUMN email_games INTEGER;

ALTER TABLE rooms ADD COLUMN quick_join INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS email_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT,
  kind        TEXT NOT NULL,
  dedupe_key  TEXT,
  ok          INTEGER NOT NULL DEFAULT 1,
  error       TEXT,
  created_ms  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_log_dedupe ON email_log(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_log_user ON email_log(user_id, created_ms);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_ms  INTEGER NOT NULL,
  expires_ms  INTEGER NOT NULL,
  used_ms     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id, created_ms);
