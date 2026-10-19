-- ============================================================
-- 0175 - who invited whom (Oct 19 insight report, Invites idea 1)
--
-- One in five new players arrives through a friend's invite, and they
-- are the likeliest to play, but nothing recorded who brought them: the
-- signup kept only a yes/no "invite" flag, room seats did not say how
-- they were taken, and an invite link opened before signup left no
-- trace. Now:
--
--   users.referred_by         the inviter: the ?by= on the link, else
--                             the host of the room the code belongs to
--   users.referred_how        'link' (named on the link) or 'host' (inferred)
--   users.signup_invite_code  the room code the account arrived with
--   room_members.join_method  host | code | browse | quick | late | admin
--                             (NULL = before this migration, or a self-heal)
--   invite_opens              one row per (link, visitor): an invite link
--                             opened, signed in or not
-- ============================================================

ALTER TABLE users ADD COLUMN referred_by TEXT;
ALTER TABLE users ADD COLUMN referred_how TEXT;
ALTER TABLE users ADD COLUMN signup_invite_code TEXT;
ALTER TABLE room_members ADD COLUMN join_method TEXT;

CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by);

CREATE TABLE IF NOT EXISTS invite_opens (
  code       TEXT    NOT NULL,
  anon_id    TEXT    NOT NULL,   -- a random id the browser keeps, not an account
  by_user    TEXT,               -- the ?by= on the link, unchecked
  user_id    TEXT,               -- the account, when the visitor was signed in
  opened_at  INTEGER NOT NULL,
  PRIMARY KEY (code, anon_id)
);
CREATE INDEX IF NOT EXISTS idx_invite_opens_time ON invite_opens(opened_at);
