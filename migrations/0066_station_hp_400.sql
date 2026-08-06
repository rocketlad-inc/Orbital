-- 0066_station_hp_400.sql
--
-- station_base_hp 180 -> 400 (Lorne), applied to LIVE stations.
--
-- 0065 had just finished restating the legacy 60-HP cohort up to 180,
-- which fixed the "upgrade never reached existing settlements" bug but
-- left the number itself too low for combat v2: a fitted destroyer was
-- observed dealing 135 damage per tick, so 180 was under two volleys.
-- 400 buys a defender three, and deliberately puts stations ABOVE cities
-- (300) — an orbital weapons platform should outlast a surface
-- settlement, which is the reverse of the old 5:3 city:station ratio.
--
-- Founding reads worker/configSchema.js (def bumped in the same commit),
-- so NEW stations arrive at 400. No game overrides station_base_hp — the
-- one config row in prod is a draft with the key absent — so the schema
-- default governs every match.
--
-- hp scales with hp_max so a station mid-bombardment keeps its damage
-- percentage. Computed against the OLD hp_max: SQLite evaluates every
-- RHS expression in an UPDATE against the original row, so reading
-- hp_max here is safe even though the same statement rewrites it.
--
-- IDEMPOTENT via the hp_restat marker 0065 introduced, bumped to 2. A
-- retry after a mid-migration 500 (which does not stamp _migrations)
-- matches zero rows. The hp_max guard is belt and braces: a station
-- already at 400 is out of scope regardless of its marker.

UPDATE game_settlements
   SET hp     = ROUND(hp * 400.0 / hp_max, 1),
       hp_max = 400,
       hp_restat = 2
 WHERE hp_restat < 2
   AND type = 'station'
   AND hp_max > 0
   AND hp_max <= 180;
