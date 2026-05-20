-- ============================================================================
-- Orbital — Dyson Sphere megaproject (Engineering Victory)
-- ============================================================================
--
-- One sphere per match. The faction that lays the foundation at a Sol-orbit
-- station becomes the controller. Per tick, every parked freighter the
-- controller owns at Sol drains a fixed quota from their empire pool and
-- contributes it to the sphere. Completing the sphere (hp >= max_hp)
-- triggers Engineering Victory.
--
-- Damage: the sphere absorbs damage routed through its foundation station
-- (see worker/room.js Dyson damage block in resolveTick). Damage reduces
-- hp and proportionally scales the accumulated resources so the progress
-- bar stays coherent. hp=0 collapses the sphere; the foundation slot
-- reopens for the next builder.
--
-- The state lives as nullable columns on the games row so we don't need a
-- separate table for a single megaproject per match. Worker code reads:
--   dyson_controller_faction_id IS NULL  → no sphere yet, slot open
--   ELSE                                  → sphere active, columns populated
-- ============================================================================

ALTER TABLE games ADD COLUMN dyson_controller_faction_id TEXT REFERENCES game_factions(id) ON DELETE SET NULL;
ALTER TABLE games ADD COLUMN dyson_foundation_settlement_id TEXT REFERENCES game_settlements(id) ON DELETE SET NULL;
ALTER TABLE games ADD COLUMN dyson_started_at_tick INTEGER;
ALTER TABLE games ADD COLUMN dyson_acc_fuel    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE games ADD COLUMN dyson_acc_ore     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE games ADD COLUMN dyson_acc_credits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE games ADD COLUMN dyson_acc_science INTEGER NOT NULL DEFAULT 0;
ALTER TABLE games ADD COLUMN dyson_target_fuel    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE games ADD COLUMN dyson_target_ore     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE games ADD COLUMN dyson_target_credits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE games ADD COLUMN dyson_target_science INTEGER NOT NULL DEFAULT 0;
ALTER TABLE games ADD COLUMN dyson_hp     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE games ADD COLUMN dyson_max_hp INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_games_dyson_controller ON games(dyson_controller_faction_id);
