-- ============================================================================
-- 0057: Discord DM notifications
--
-- Everything the bot did until now was BROADCAST — a digest, a vote card,
-- posted to a channel on a schedule. Nothing ever reached a specific
-- person. In a game where a tick is an hour, that is the whole engagement
-- problem: analytics show players 10 and 34 days idle who never decided
-- to quit, nothing simply pulled them back.
--
-- Two tables:
--
--   notification_prefs — per user, per category, on/off. Opt-OUT (absent
--     row = enabled) because a notification nobody asked for is the
--     entire point of a re-engagement ping. /notify turns them off.
--
--   notification_log — one row per delivered DM. Serves three jobs:
--     dedupe (never tell you twice about the same battle), rate limiting
--     (an idle nudge at most once a week), and honest measurement of
--     whether any of this actually brings people back.
-- ============================================================================

CREATE TABLE notification_prefs (
  user_id     TEXT NOT NULL,
  category    TEXT NOT NULL,      -- 'dm'|'combat'|'senate'|'economy'|'digest'|'nudge'
  enabled     INTEGER NOT NULL DEFAULT 1,
  updated_ms  INTEGER NOT NULL,
  PRIMARY KEY (user_id, category)
);

CREATE TABLE notification_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  game_id     TEXT,
  category    TEXT NOT NULL,
  -- Stable identity of the THING being reported (a message id, a battle
  -- at a body on a tick). The unique index below is what makes repeat
  -- delivery impossible rather than merely unlikely.
  dedupe_key  TEXT,
  ok          INTEGER NOT NULL DEFAULT 1,   -- 0 = send failed (DMs closed, etc)
  created_ms  INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_notif_dedupe ON notification_log(user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_notif_user_time ON notification_log(user_id, created_ms);
