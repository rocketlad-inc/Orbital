-- ============================================================
-- 0143 — the watch's own alerts.
--
-- Until now the watch only ever showed the PHONE's notifications,
-- mirrored by Wear OS: one card, whatever the phone got, and every
-- button ran on the phone. The watch now has a feed of its own
-- (worker/wearAlerts.js): every alert the server raises for a player
-- who holds a watch token is also written here, with the screen it
-- belongs to, and the watch collects it by cursor (id) and posts it
-- natively -- opening the right page of the watch app, acting through
-- the watch's own orders token.
--
-- `subject` names the thing the alert is about ("bill:<id>",
-- "trade:<id>", "battle:<id>", "msg:<id>") so the feed can tell the
-- watch which alerts are already dealt with -- voted, answered, over,
-- read -- and it can clear them, wherever the player acted.
--
-- Short-lived by design: rows older than three days are pruned when
-- the feed is read. A watch that has been off for longer does not want
-- three days of turns delivered at once anyway.
-- ============================================================

CREATE TABLE IF NOT EXISTS wear_alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  game_id     TEXT,
  category    TEXT NOT NULL,
  dedupe_key  TEXT,
  subject     TEXT,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  -- empire | battles | senate | systems | territory | comms | yards | porthole
  screen      TEXT NOT NULL,
  -- the body id a 'porthole' alert opens on; otherwise informational
  ref         TEXT,
  -- JSON [{id, label, reply?, verb}] -- the same verbs as a phone button
  actions     TEXT,
  created_ms  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS wear_alerts_user ON wear_alerts (user_id, id);

-- One per event per player, exactly like notification_log's keys.
CREATE UNIQUE INDEX IF NOT EXISTS wear_alerts_dedupe
  ON wear_alerts (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- The watch's own switch per category. NULL = never set, which follows
-- the PHONE's answer (itself following Discord's until set -- 0133), so
-- nobody's watch starts saying something their phone was told not to.
ALTER TABLE notification_prefs ADD COLUMN watch_enabled INTEGER;
