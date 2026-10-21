-- ============================================================
-- 0180 - where link and ad traffic goes BEFORE it signs up
--
-- users.signup_source only exists once an account does, so a paid
-- click that looked and left was invisible: "no signups from the ad"
-- could not be told from "nobody clicked the ad". Now every tagged
-- or referred visit leaves an anonymous row, and the sign-in screen
-- reports how far the visitor got.
--
--   campaign_visits  one row per browser (the anon id it keeps), its
--                    FIRST tagged/referred arrival: the link tags, the
--                    ad network's click id, device, in-app browser,
--                    country, and the account it later made
--   campaign_steps   one row per (browser, step) on the way to signup:
--                    engaged / signup_tab / email_try / google_try /
--                    login_try / auth_error / google_error
--
-- Nothing here names a person until signup_user_id is stamped by the
-- signup itself (worker/visits.js linkVisitToUser).
-- ============================================================

CREATE TABLE IF NOT EXISTS campaign_visits (
  anon_id         TEXT    PRIMARY KEY,   -- random id the browser keeps, not an account
  source          TEXT    NOT NULL,      -- same label signup_source would get
  campaign        TEXT,                  -- utm_campaign
  content         TEXT,                  -- utm_content (an ad)
  term            TEXT,                  -- utm_term (a keyword)
  medium          TEXT,                  -- utm_medium
  click_kind      TEXT,                  -- 'reddit' | 'google' | 'meta' | 'tiktok' | 'microsoft' | 'x'
  click_id        TEXT,                  -- rdt_cid / gclid / fbclid / ... for a later conversion report
  referrer        TEXT,                  -- referring site, cleaned
  landing         TEXT,                  -- path landed on
  device          TEXT,                  -- 'phone' | 'tablet' | 'desktop'
  in_app          TEXT,                  -- in-app browser it opened in (reddit, facebook, ...) or NULL
  country         TEXT,                  -- two letters, from Cloudflare
  viewer_user_id  TEXT,                  -- signed in already when it landed (an existing player)
  signup_user_id  TEXT,                  -- the account this browser went on to create
  first_ms        INTEGER NOT NULL,
  last_ms         INTEGER NOT NULL,
  visits          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_campaign_visits_first ON campaign_visits(first_ms);
CREATE INDEX IF NOT EXISTS idx_campaign_visits_signup ON campaign_visits(signup_user_id);

CREATE TABLE IF NOT EXISTS campaign_steps (
  anon_id  TEXT    NOT NULL,
  step     TEXT    NOT NULL,
  at_ms    INTEGER NOT NULL,
  PRIMARY KEY (anon_id, step)
);
