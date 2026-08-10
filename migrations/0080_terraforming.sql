-- 0080: terraforming — the world-level upgrade that replaces collectors.
--
-- Design (Lorne, 2026-08-10): a body is either RAW or TERRAFORMED.
-- Terraformed worlds route 100% of settlement yield to the faction pool,
-- host cities and city-buildings, and serve as trade endpoints. Raw
-- worlds trickle 10% to the pool, hoard 90% in local stockpiles, and can
-- host stations only. Terraforming is fed by freighter supply routes
-- from an already-terraformed world (mirroring the Dyson supply line),
-- then runs a fixed transformation window. It is PERMANENT — survives
-- conquest and razing; only an asteroid strike clears it.
--
-- This migration is stage 1 of the rollout: columns + backfill only.
-- Nothing reads these fields yet, so applying it changes no behavior.

-- NULL = raw. 0 = terraformed at game start (capitals, Earth, backfill).
ALTER TABLE game_bodies ADD COLUMN terraformed_at_tick INTEGER;

-- The delivery meter. Filled by terraform supply routes; when both
-- components reach the configured cost the transformation window opens.
-- Lives on the BODY, not the faction — progress transfers with conquest,
-- same king-of-the-hill shape as the Dyson accumulator.
ALTER TABLE game_bodies ADD COLUMN terraform_acc_metal REAL NOT NULL DEFAULT 0;
ALTER TABLE game_bodies ADD COLUMN terraform_acc_gold REAL NOT NULL DEFAULT 0;

-- Set when the meter fills: current_tick + terraform_duration_ticks.
-- The tick pass flips terraformed_at_tick when it elapses.
ALTER TABLE game_bodies ADD COLUMN terraform_completes_at_tick INTEGER;

-- Route taxonomy. 'logistics' = classic stockpile hauling (now raw ->
-- terraformed), 'terraform' = feeds a body's terraform meter, 'dyson' =
-- feeds the sphere. Existing Sol routes are dyson runs by definition.
ALTER TABLE game_trade_routes ADD COLUMN kind TEXT NOT NULL DEFAULT 'logistics';

UPDATE game_trade_routes SET kind = 'dyson'
 WHERE dest_body_id LIKE '%:sol' AND cancelled_at_tick IS NULL;

-- Backfill: every body that today hosts a living city OR a collector
-- becomes terraformed. Required, not generous — the hard city gate
-- would otherwise strand existing cities on raw worlds as illegal
-- state. Collectored gas giants / asteroids lose collector status by
-- design but gain terraform status here; the type gate only applies to
-- NEW terraforming, not the grandfather clause (a live game's economy
-- must not shrink mid-match).
UPDATE game_bodies SET terraformed_at_tick = 0
 WHERE terraformed_at_tick IS NULL
   AND id IN (
     SELECT DISTINCT body_id FROM game_settlements
      WHERE destroyed_at_tick IS NULL
        AND (type = 'city' OR has_collector = 1)
   );
