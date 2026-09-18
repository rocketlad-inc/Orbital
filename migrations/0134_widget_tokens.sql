-- 0134_widget_tokens.sql
--
-- THE HOME-SCREEN WIDGET'S KEY, and the reason it needs one at all.
--
-- A widget is native Android code. It runs outside the Trusted Web
-- Activity, so it cannot see the session cookie that Chrome holds inside
-- the app — /api/me/... is closed to it. It needs a credential of its
-- own, and that credential ends up sitting in a URL on a device,
-- refetched every half hour forever.
--
-- So this is deliberately NOT a session. It is one narrow capability:
-- "render this user's status card as an image". It cannot read messages,
-- cannot issue orders, cannot be exchanged for a session. The worst a
-- leaked token does is show someone your resource counts, and revoking
-- it is one row.
--
-- revoked_ms rather than DELETE, so "I revoked this and the widget kept
-- working" can be answered from the table instead of from memory.
-- last_used_ms is there for the same reason: a widget that has silently
-- stopped refreshing is otherwise invisible from the server side.

CREATE TABLE IF NOT EXISTS widget_tokens (
  token        TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        TEXT,
  created_ms   INTEGER NOT NULL,
  last_used_ms INTEGER,
  revoked_ms   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_widget_tokens_user ON widget_tokens(user_id);
