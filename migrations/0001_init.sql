-- Users: one row per account.
-- password_hash format: "pbkdf2$<iters>$<salt_b64>$<hash_b64>"
CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE INDEX idx_users_email ON users(LOWER(email));

-- Sessions: opaque token -> user. Token is the cookie value (random 32 bytes, base64url).
CREATE TABLE sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  user_agent  TEXT
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
