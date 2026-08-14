-- ============================================================
-- 0086 — a standing trade gets a grace period before it dies
--
-- Until now the FIRST time a freighter reached its pickup and the
-- sender's pool could not cover that run, the whole agreement ended on
-- the spot, both legs, permanently. One bad tick destroyed a deal rather
-- than delaying a shipment — and because the cost is only checked at the
-- moment of pickup, a player who was momentarily light (mid-build,
-- mid-terraform) lost the arrangement outright with no way back.
--
-- starved_since_tick is the first tick this leg found itself unable to
-- load. It clears the moment a pickup succeeds. Only when the leg has
-- been stuck for TRADE_STARVE_GRACE_TICKS does the agreement end.
--
-- On the route rather than the agreement on purpose: each leg starves
-- independently (either side can be the one that cannot pay), and the
-- ending needs to name WHICH side ran dry.
-- ============================================================

ALTER TABLE game_trade_routes ADD COLUMN starved_since_tick INTEGER;

-- WHO ran dry. The chronicle entry already carried this, but the Trades
-- panel reads the AGREEMENT, not the log, so both parties saw the same
-- blameless "a shipment could not be covered" and each assumed it was
-- the other one who had failed to pay. Recording it on the row is what
-- lets the panel say "you" or name the partner.
ALTER TABLE trade_agreements ADD COLUMN ended_by_faction_id TEXT;
