-- ============================================================
-- 0149 — visits, and the one-time invite to the feedback Discord
--
-- A "visit" is opening Orbital more than 30 minutes after the account
-- was last seen (worker/index.js noteVisit). Sessions last thirty days,
-- so password logins are rare and would make a poor count.
--
-- On the SECOND visit a player is invited, once, to give feedback in the
-- Discord. discord_prompt_ms stamps when they answered (the popup is
-- never shown again after that); discord_prompt_action is what they
-- chose: 'joined' or 'dismissed'.
--
-- BACKFILL: everyone who already has an account has had their first
-- visit, so they start at 1 and their next visit after this ships is
-- their second.
-- ============================================================

ALTER TABLE users ADD COLUMN visit_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN last_visit_ms INTEGER;
ALTER TABLE users ADD COLUMN discord_prompt_ms INTEGER;
ALTER TABLE users ADD COLUMN discord_prompt_action TEXT;

UPDATE users SET visit_count = 1;
