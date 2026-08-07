-- 0071_corvette_damage_buff.sql
--
-- Corvette base damage 3.75 -> 7 (Lorne), applied to hulls already built.
--
-- WHY. The combat-v2 sims validated the hit matrix and it holds up in
-- production — corvette->destroyer is landing 84.8% against a predicted
-- 89%. What the sims missed is that they modelled BARE hulls while the
-- field flies FITTED ones, and slot count (2/4/6) multiplies both HP and
-- damage at once:
--
--   class      parts HP mul   parts dmg mul   combined
--   corvette      x1.00           x1.68         x1.68
--   frigate       x1.28           x2.17         x2.78
--   destroyer     x2.71           x2.26         x6.12
--
-- Corvettes field NO armor at all: with two slots a plate costs half the
-- loadout, so nobody takes one. A 10:1 base HP gap became 27:1 fielded
-- (72 vs 1,951 effective HP), and combat power per credit came out
-- corvette 0.70 / frigate 3.09 / destroyer 9.44. It took ~79 corvettes,
-- at 13.9x the price, to trade evenly with one destroyer.
--
-- WHAT THIS DOES. Damage x1.8667 roughly halves that: ~43 corvettes at
-- 7.6x the price, and power per credit 0.70 -> 1.31. It does NOT make
-- corvettes efficient line combatants — the gap is structural (slots
-- compounding), not a damage number — but it is a real improvement to
-- the swarm and it leaves the hit matrix, speed and travel untouched.
--
-- damage_per_tick is stamped at BUILD time from the class base times
-- fitted mounts and weapons tech, so changing the base only affects new
-- hulls. Every multiplier downstream is proportional, which is why the
-- existing fleet can be restated by a single constant without re-parsing
-- parts_json.
--
-- IDEMPOTENT, structurally: one UPDATE that sets the marker column it
-- uses as its own WHERE clause, so a retry after a mid-migration 500
-- (which does NOT stamp _migrations) matches zero rows. Doubling a
-- damage buff silently would be unrecoverable.

ALTER TABLE game_ships ADD COLUMN corvette_buff_v1 INTEGER NOT NULL DEFAULT 0;

UPDATE game_ships
   SET damage_per_tick = ROUND(damage_per_tick * 1.8666666667, 1),
       corvette_buff_v1 = 1
 WHERE corvette_buff_v1 = 0
   AND ship_class = 'corvette';
