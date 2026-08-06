-- 0065_settlement_hp_restat.sql
--
-- The settlement HP triple never reached the settlements that already
-- existed. city_base_hp 100 -> 300 and station_base_hp 60 -> 180 changed
-- the DEFAULTS in worker/configSchema.js, but hp/hp_max are stamped at
-- FOUNDING (worker/actions.js reads the config once and writes literals),
-- so only settlements founded after that deploy got the new numbers.
--
-- Live at time of writing, and exactly two cohorts — no drift to reason
-- about:
--
--   city     100  x54     <- legacy, restated here
--   city     300  x11     <- founded post-triple, untouched
--   station   60  x40     <- legacy, restated here   (Lorne's Thoth Station)
--   station  180  x16     <- founded post-triple, untouched
--
-- Lorne: "I thought we upgraded station health? It's still showing 60?
-- That's like two hits from a destroyer." It was — and at combat v2
-- damage it was worse than that (see the note at the bottom).
--
-- hp scales with hp_max by the same factor, so a settlement under
-- bombardment keeps its damage percentage. A half-wrecked station comes
-- out half-wrecked, not healed and not newly critical.
--
-- IDEMPOTENT, structurally: one UPDATE that sets the marker it uses as
-- its own WHERE clause, so a retry after a mid-migration 500 (which does
-- NOT stamp _migrations) matches zero rows. The cohort test is belt and
-- braces on top — an already-tripled row fails it regardless.
--
-- NOTE for whoever tunes this next: a stock combat v2 destroyer deals 45
-- damage per landed hit, and a well-fitted one was observed at 135/tick.
-- 180 HP is 4 stock hits but under 2 from a real destroyer. If stations
-- are still melting, this is a config change (station_base_hp), not
-- another migration -- the Editor writes it per game.

ALTER TABLE game_settlements ADD COLUMN hp_restat INTEGER NOT NULL DEFAULT 0;

UPDATE game_settlements
   SET hp_max = ROUND(hp_max * 3, 1),
       hp     = ROUND(hp * 3, 1),
       hp_restat = 1
 WHERE hp_restat = 0
   AND ((type = 'city'    AND hp_max <= 100)
     OR (type = 'station' AND hp_max <= 60));
