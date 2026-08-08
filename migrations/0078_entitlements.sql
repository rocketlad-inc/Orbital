-- 0078_entitlements.sql
--
-- PREMIUM COSMETICS (Lorne): one $10 purchase unlocks extra ship icon
-- variants and flag emblems, forever, on the ACCOUNT — not the faction,
-- not the game. Cosmetics only; nothing that touches the simulation is
-- ever for sale.
--
-- One row per (user, sku). The sku is a string, not a boolean column,
-- because the second product ("map pack", "chronicle") must not need a
-- migration — it's just a new sku value.
--
-- stripe_session_id carries the Stripe Checkout session that paid for
-- the grant, and its UNIQUE index is the webhook idempotency key:
-- Stripe redelivers events until acknowledged, and without the
-- constraint a redelivery would double-grant (harmless) or, worse,
-- interleave with a refund revoke (not harmless). Admin grants have no
-- session — NULLs don't collide in a SQLite UNIQUE index.
--
-- stripe_payment_intent is stored because REFUNDS arrive keyed by
-- payment intent, not by checkout session. Without it, mapping a
-- charge.refunded event back to the row it should revoke would need a
-- Stripe API round-trip inside the webhook handler.
--
-- source/granted_by: the audit trail for the admin override. 'stripe'
-- rows came from money; 'admin' rows name the admin email that granted
-- them, so a mystery premium account is always one SELECT from an
-- explanation.

CREATE TABLE IF NOT EXISTS user_entitlements (
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sku                   TEXT NOT NULL,
  source                TEXT NOT NULL DEFAULT 'stripe',   -- 'stripe' | 'admin'
  granted_by            TEXT,                              -- admin email when source='admin'
  stripe_session_id     TEXT,
  stripe_payment_intent TEXT,
  granted_at            INTEGER NOT NULL,
  PRIMARY KEY (user_id, sku)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entitlements_stripe_session
  ON user_entitlements(stripe_session_id) WHERE stripe_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entitlements_payment_intent
  ON user_entitlements(stripe_payment_intent) WHERE stripe_payment_intent IS NOT NULL;
