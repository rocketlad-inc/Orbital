-- Player-editable flavor text for chronicle entries (EventLog Phase 3).
--
-- The EventLog generates prose flavor client-side from a template bank.
-- This lets the factions involved in an event (actor / target) — or the
-- host — rewrite that flavor into their own narrative, synced to every
-- player via /state. Last-write-wins.
--
-- Additive-only, all nullable:
--   flavor_override     the custom prose (NULL = use the generated flavor)
--   flavor_edited_by    faction id that last edited (for the attribution
--                       footer "— rewritten by X")
--   flavor_edited_at_ms wall-clock of the last edit
ALTER TABLE chronicle_entries ADD COLUMN flavor_override TEXT;
ALTER TABLE chronicle_entries ADD COLUMN flavor_edited_by TEXT;
ALTER TABLE chronicle_entries ADD COLUMN flavor_edited_at_ms INTEGER;
