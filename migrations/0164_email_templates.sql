-- ============================================================
-- 0164 — an editable win-back email, and whether mail gets opened
--
-- email_templates holds the admin panel's edits to an automated email
-- (worker/emailAdmin.js): an on/off switch and per-language overrides of
-- the copy. A missing row, or enabled = 0, means the email does not send,
-- so the win-back ships switched off until Lorne turns it on.
--
-- email_log gains the open: a 1x1 picture in the email, fetched from
-- /api/email/o/<signed id>.gif, stamps the first open and counts the rest.
-- Opens are a floor and a ceiling at once: clients that block pictures
-- never report one, and Apple Mail fetches every picture on delivery.
-- ============================================================

CREATE TABLE IF NOT EXISTS email_templates (
  id          TEXT PRIMARY KEY,
  enabled     INTEGER NOT NULL DEFAULT 0,
  overrides   TEXT NOT NULL DEFAULT '{}',
  updated_ms  INTEGER,
  updated_by  TEXT
);

ALTER TABLE email_log ADD COLUMN opened_ms INTEGER;
ALTER TABLE email_log ADD COLUMN open_count INTEGER NOT NULL DEFAULT 0;
