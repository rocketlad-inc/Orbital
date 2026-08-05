-- 0062_combat_v2_restat.sql
--
-- COMBAT V2 (DESIGN-combat-v2.md). Ship stats are stamped at BUILD time, so
-- changing SHIP_COMBAT_STATS only affects hulls built from now on. Without
-- this migration two generations of ship would fight under one rule set and a
-- destroyer built yesterday would be permanently worse than one built
-- tomorrow. Lorne: "We'll need to migrate all existing ships."
--
-- Live at time of writing: 207 destroyers, 63 frigates, 19 corvettes,
-- 32 freighters, 4 colony ships.
--
-- The stat formula is unchanged — hp = base.hp * (1 + 0.35*defensive parts),
-- damage = base.damage * (1 + 0.40*mounts*tech) — so only the BASE moved and
-- every existing hull can be restated by a per-class constant. No need to
-- re-parse parts_json.
--
--   class       hp base        damage base        hp x     damage x
--   corvette    40 -> 40       5     -> 3.75      1.0      0.75
--   frigate     100 -> 100     10    -> 20.25     1.0      2.025
--   destroyer   200 -> 400     18    -> 45        2.0      2.5
--   freighter   60 -> 60       0     -> 0         1.0      1.0
--   colony      60 -> 60       0     -> 0         1.0      1.0
--
-- Only destroyers change HP. `hp` scales with `hp_max` so a hull at 50% stays
-- at 50% — a destroyer does not get healed for free, and does not suddenly
-- read as damaged either.
--
-- IDEMPOTENT. The runner (worker/index.js) skips applied migrations, but a
-- mid-migration failure returns 500 WITHOUT stamping, so a retry re-runs every
-- statement. Scaling twice would be silent and unrecoverable, so the guard is
-- structural: one UPDATE that sets the marker in the same statement it uses as
-- its WHERE clause. Re-running matches zero rows.

ALTER TABLE game_ships ADD COLUMN combat_v2 INTEGER NOT NULL DEFAULT 0;

UPDATE game_ships
   SET hp = ROUND(hp * CASE ship_class WHEN 'destroyer' THEN 2.0 ELSE 1.0 END, 1),
       hp_max = ROUND(hp_max * CASE ship_class WHEN 'destroyer' THEN 2.0 ELSE 1.0 END, 1),
       damage_per_tick = ROUND(damage_per_tick * CASE ship_class
                                 WHEN 'corvette'  THEN 0.75
                                 WHEN 'frigate'   THEN 2.025
                                 WHEN 'destroyer' THEN 2.5
                                 ELSE 1.0 END, 1),
       combat_v2 = 1
 WHERE combat_v2 = 0;
