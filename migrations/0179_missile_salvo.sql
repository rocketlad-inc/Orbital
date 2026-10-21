-- Missile Silo, part 2: the salvo auto-defence sends at each hostile group
-- it intercepts in flight (and at hulls landing uncaught). Lorne 2026-10-19.
ALTER TABLE game_settlements ADD COLUMN missile_salvo INTEGER NOT NULL DEFAULT 2;
