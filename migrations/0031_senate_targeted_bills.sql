-- Targeted bills + new bill kinds (trade_embargo, war_authorization,
-- production_sanction). Plus a Chancellor election kind that doesn't
-- write an effects row (its "effect" is winning the match).
--
-- Existing senate_effects rows are all slider laws (effect_kind='slider'),
-- global (target_faction_id NULL). New ongoing-effect kinds re-use this
-- table with effect_kind set per bill kind and target_faction_id pointing
-- at the faction the sanction is aimed at. Reparations is a one-shot
-- credit transfer handled at proposal resolution time — it does NOT write
-- an effects row.

ALTER TABLE senate_effects ADD COLUMN effect_kind        TEXT NOT NULL DEFAULT 'slider';
ALTER TABLE senate_effects ADD COLUMN target_faction_id  TEXT REFERENCES game_factions(id);

-- Index for the common runtime query: "is there an active <kind> effect
-- aimed at this faction right now?" — embargoes asked per route, war-auth
-- asked per combat tick, production-sanction asked per harvest.
CREATE INDEX IF NOT EXISTS idx_senate_effects_target
  ON senate_effects(game_id, effect_kind, target_faction_id, active_until_tick);
