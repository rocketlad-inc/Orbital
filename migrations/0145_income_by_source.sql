-- ============================================================
-- 0145 — what each tick paid into an empire's pool, by source
--
-- The ledger (0087) records pool LEVELS and upkeep, from which total
-- income can be derived, but not where it came from. The tick report
-- now says it every tick -- freighter deliveries, terraformed worlds,
-- the raw worlds' 10% trickle -- so the tick books each source as it
-- banks it (room.js noteIncome) and writes the result here:
--
--   {"delivered":{"metal":..,"gold":..,"science":..},
--    "terraformed":{...}, "raw":{...}}
--
-- NULL for ticks before this, and for a faction nothing paid into.
-- ============================================================

ALTER TABLE faction_economy_ticks ADD COLUMN income_json TEXT;
