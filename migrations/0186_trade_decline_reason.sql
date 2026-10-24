-- Why an offer was declined (worker/trades.js handleDecline). A computer
-- empire answers a counter-offer with one of these codes instead of a
-- silent no (playtest 2026-10-24); a person may send none (NULL).
--   no_cargo        it ships no goods: ask for a pact, or send a gift
--   no_pacts        it signs no pacts (the Warlord)
--   no_trust        it holds a grudge against you
--   unknown_terms   terms it cannot read
ALTER TABLE trade_offers ADD COLUMN decline_reason TEXT;
