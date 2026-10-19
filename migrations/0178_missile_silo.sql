-- ============================================================
-- 0177 — the Missile Silo (worker/missiles.js).
--
-- A city building that builds, stores and fires single-use missiles
-- (Lorne, 2026-10-19). Its level lives in buildings_json like any
-- building; its MAGAZINE and its own build queue live here, never in
-- buildings_json, whose every key is read as a level.
--
-- game_settlements:
--   missile_stock        missiles ready to fire (capacity 5 per level)
--   missile_orders_json  its build queue: [{id, ticks, start_tick,
--                        complete_tick, cost}], first one building
--   missile_auto         'off' | 'missiles' | 'fleets' (auto-defence)
--   missile_reserve      missiles auto-defence never spends
-- game_ships (class 'missile', one row per launched salvo):
--   missile_count               missiles in the salvo
--   missile_from_settlement_id  the silo that fired it
-- All additive and idempotent: a second run only repeats ADD COLUMNs,
-- which the runner tolerates.
-- ============================================================

ALTER TABLE game_settlements ADD COLUMN missile_stock INTEGER NOT NULL DEFAULT 0;
ALTER TABLE game_settlements ADD COLUMN missile_orders_json TEXT;
ALTER TABLE game_settlements ADD COLUMN missile_auto TEXT NOT NULL DEFAULT 'off';
ALTER TABLE game_settlements ADD COLUMN missile_reserve INTEGER NOT NULL DEFAULT 0;
ALTER TABLE game_ships ADD COLUMN missile_count INTEGER;
ALTER TABLE game_ships ADD COLUMN missile_from_settlement_id TEXT;
