-- ============================================================
-- 0165 — sign in from the win-back email; remember who was invited where
--
-- email_login_tokens: a link in an email that signs its reader in, like a
-- password reset (only the SHA-256 is stored; one use; seven days). The
-- win-back email's button carries one, so a player who forgot their
-- password still lands in their seat with one click (worker/emailLogin.js).
-- room_id is the lobby the email named; the sign-in sends them there.
--
-- email_log.room_id: the lobby a win-back email invited its reader to.
-- The hourly planner counts the invitations still out for each lobby and
-- only tops up the difference, instead of inviting two more people per
-- open seat every hour (worker/winback.js).
-- ============================================================

CREATE TABLE IF NOT EXISTS email_login_tokens (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  purpose     TEXT NOT NULL,
  room_id     TEXT,
  created_ms  INTEGER NOT NULL,
  expires_ms  INTEGER NOT NULL,
  used_ms     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_email_login_tokens_expiry ON email_login_tokens(expires_ms);

ALTER TABLE email_log ADD COLUMN room_id TEXT;
CREATE INDEX IF NOT EXISTS idx_email_log_kind_room ON email_log(kind, room_id, created_ms);
