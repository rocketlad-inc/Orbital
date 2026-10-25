-- ============================================================
-- 0187 - Play for Free, tracked end to end (admin dashboard)
--
--   users.shadow_claimed_by     the account a trial was saved into, so a
--                               trial can be followed past its save
--   campaign_visits.trial_user_id
--                               the trial (shadow) account this browser
--                               started. Trials used to stamp
--                               signup_user_id instead: the traffic table
--                               then dropped the visit (a shadow is QA by
--                               domain), and the real account made on
--                               saving could never link to it.
--
-- The UPDATE moves those early links over. Safe to run twice.
-- ============================================================
ALTER TABLE users ADD COLUMN shadow_claimed_by TEXT;
ALTER TABLE campaign_visits ADD COLUMN trial_user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_campaign_visits_trial ON campaign_visits(trial_user_id);
UPDATE campaign_visits SET trial_user_id = signup_user_id, signup_user_id = NULL
 WHERE signup_user_id IN (SELECT id FROM users WHERE shadow > 0);
