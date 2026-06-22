-- Google OAuth support (production-safe, additive-only).
--
-- The original SSO migration (feat/google-sso branch, numbered 0014)
-- rebuilt the entire `users` table to relax password_hash from NOT
-- NULL to nullable. On a live database that is DANGEROUS: this app's
-- migration runner (worker/index.js) executes each statement as its
-- own D1 call rather than one wrapped transaction, so a `DROP TABLE
-- users` can fire the ON DELETE CASCADE foreign keys that rooms,
-- room members, and game seats declare against users(id) — cascade-
-- wiping real lobby/game data.
--
-- This rewrite avoids the rebuild completely. Two additive changes:
--
--   1) Add google_sub: the canonical Google account ID (JWT 'sub'
--      claim). SQLite can't add a UNIQUE column inline via ALTER
--      TABLE, so the column is added plain and uniqueness is enforced
--      by a separate UNIQUE INDEX. SQLite permits multiple NULLs in a
--      unique index, so every existing (Google-less) user keeps a
--      NULL google_sub without colliding.
--
--   2) password_hash STAYS NOT NULL. Google-only accounts are
--      provisioned with password_hash = '' (empty string) instead of
--      NULL — see handleGoogleAuth in worker/index.js. verifyPassword
--      rejects '' immediately (''.split('$') has length 1, not 4), so
--      a Google-only account can never be authenticated through the
--      password form. This sidesteps the NOT NULL relaxation that
--      forced the destructive rebuild.

ALTER TABLE users ADD COLUMN google_sub TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub);
