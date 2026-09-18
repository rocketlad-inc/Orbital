-- Web push subscriptions — one row per DEVICE, not per player.
--
-- A player with a phone and a desktop has two, and both should ring: the
-- point of push is reaching the person wherever they are. The endpoint
-- URL is the browser's own address for that installation and is unique,
-- so it is the natural key; re-subscribing on the same device returns
-- the same endpoint and must update rather than duplicate.
--
-- KEYS. p256dh is the device's public ECDH key and auth is a shared
-- secret; together they are what lets us encrypt a payload only that
-- browser can open (RFC 8291). They are not credentials for anything
-- else and are useless without the endpoint.
--
-- failed_at_ms / fail_count: a push service answers 404 or 410 when a
-- subscription is dead for good (app uninstalled, data cleared,
-- permission revoked). Those rows are deleted on sight. Anything else is
-- transient and only counted, so one bad afternoon at a push service
-- does not unsubscribe a player.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint     TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  user_agent   TEXT,
  created_ms   INTEGER NOT NULL,
  last_ok_ms   INTEGER,
  failed_at_ms INTEGER,
  fail_count   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions (user_id);
