-- ============================================================
-- 0153 — the Commission: where it sells, gifts, and one honest ask
--
-- On 2026-10-05 the Commander's Commission had one paid sale and no
-- record of anything before checkout: nobody could tell which of its
-- surfaces (profile, lobby flag picker, designer...) sold it. This adds
-- what the insight report asked for, with no gameplay effect at all.
--
-- user_entitlements.surface   which surface the purchase started from
--                             (profile, lobby-flag, designer, endgame,
--                             thanks-card, gift). NULL on older rows.
-- user_entitlements.gift_code set when the Commission came from a gift,
--                             so refunding the gift can take it back.
-- commission_gifts            one row per Commission bought FOR someone
--                             else: the code the buyer passes on, and
--                             who redeemed it. A full refund voids an
--                             unredeemed code and revokes a redeemed one.
-- users.commission_ask_*      the one-time thank-you card after ~20
--                             hours of play. Answered once, never shown
--                             again (the same rule as the Discord invite).
-- ============================================================

ALTER TABLE user_entitlements ADD COLUMN surface TEXT;
ALTER TABLE user_entitlements ADD COLUMN gift_code TEXT;

CREATE TABLE IF NOT EXISTS commission_gifts (
  code                  TEXT PRIMARY KEY,
  sku                   TEXT NOT NULL DEFAULT 'cosmetics_v1',
  buyer_user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_session_id     TEXT NOT NULL UNIQUE,
  stripe_payment_intent TEXT,
  created_at            INTEGER NOT NULL,
  redeemed_by           TEXT REFERENCES users(id) ON DELETE SET NULL,
  redeemed_at           INTEGER,
  voided_at             INTEGER
);
CREATE INDEX IF NOT EXISTS idx_commission_gifts_buyer ON commission_gifts(buyer_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_commission_gifts_intent ON commission_gifts(stripe_payment_intent)
  WHERE stripe_payment_intent IS NOT NULL;

ALTER TABLE users ADD COLUMN commission_ask_ms INTEGER;
ALTER TABLE users ADD COLUMN commission_ask_action TEXT;
