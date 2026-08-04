-- ============================================================================
-- 0058: Bot settings
--
-- Everything the bot does was compile-time constant: the Herald's hour,
-- whether quiet situation reports send, which channel receives what.
-- Changing any of it meant a code edit and a deploy, which is a poor fit
-- for knobs whose right value is discovered by watching real players
-- react — "6pm not noon" is a preference, not an engineering decision.
--
-- Deliberately a key/value table rather than typed columns: the settings
-- list will churn as the bot grows, and a migration per knob would be
-- worse than parsing a few strings. Values are JSON so a setting can
-- become an object later without another migration.
-- ============================================================================

CREATE TABLE bot_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,        -- JSON-encoded
  updated_ms  INTEGER NOT NULL,
  updated_by  TEXT                  -- user id, for an audit trail
);
