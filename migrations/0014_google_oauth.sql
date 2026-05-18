-- Google OAuth support.
--
-- Two changes:
--   1) Add google_sub: the canonical Google account ID (the JWT 'sub' claim).
--      Unique so two users can't accidentally bind the same Google account.
--      Indexed so the /api/auth/google lookup is fast.
--   2) Relax password_hash from NOT NULL to nullable. Google-only accounts
--      never set a password — they sign in exclusively via Google. Existing
--      password+email accounts are unaffected and can later attach a Google
--      identity to their row (the upsert logic in /api/auth/google does this
--      by matching on email).
--
-- SQLite doesn't support ALTER COLUMN, so we rebuild the table the standard
-- "12-step" way: rename old, create new with the relaxed schema, copy data,
-- drop old, recreate indexes. The unique constraints on email and google_sub
-- catch any race conditions during the migration window.

CREATE TABLE users_new (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT,                   -- nullable now: Google-only accounts
  google_sub    TEXT UNIQUE,            -- nullable: not all users use Google
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

INSERT INTO users_new (id, email, display_name, password_hash, created_at, last_login_at)
SELECT id, email, display_name, password_hash, created_at, last_login_at FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

CREATE INDEX idx_users_email ON users(LOWER(email));
CREATE INDEX idx_users_google_sub ON users(google_sub);
