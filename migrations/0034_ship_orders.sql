-- Ship standing orders (DESIGN-identity-economy.md §3).
--
--   stance          : 'attack' | 'defensive' | 'hold'. NULL = 'attack'
--                     (attack-on-sight, identical to pre-orders behavior).
--   retreat_hp_pct  : NULL | 25 | 50 | 75. When set, a damaged ship whose
--                     hp/hp_max drops to or below the threshold auto-
--                     transfers to the nearest friendly body with a
--                     shipyard-equipped station. NULL = never retreat.
--   detonate_hp_pct : NULL | 25 | 50. Dead-man switch for detonator-part
--                     hulls: auto-trigger the detonator below threshold.
--                     Inert on ships without a detonator part.
--
-- D1 requires one ALTER per statement.
ALTER TABLE game_ships ADD COLUMN stance TEXT;
ALTER TABLE game_ships ADD COLUMN retreat_hp_pct INTEGER;
ALTER TABLE game_ships ADD COLUMN detonate_hp_pct INTEGER;
