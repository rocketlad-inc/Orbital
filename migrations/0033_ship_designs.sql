-- Ship designer (DESIGN-identity-economy.md §2).
--
-- game_ship_designs: named per-player design library. Each design is a
-- hull class + a parts loadout (parts_json: JSON array of part ids,
-- e.g. '["weapon","weapon","shield"]') + an icon variant. One ACTIVE
-- design per (faction, ship_class) — enforced in the activate handler
-- (worker/actions.js), not by a constraint, because SQLite can't
-- express a partial-unique cleanly across the migration path.
--
-- parts_json on game_body_build_queue: the active design's loadout is
-- SNAPSHOT onto the build order at queue time, so editing a design
-- never mutates queued ships.
--
-- parts_json on game_ships: copied from the build order at completion
-- (worker/room.js). NULL = bare hull = exactly today's stats — this is
-- the live-game migration story; every existing ship stays untouched.
CREATE TABLE game_ship_designs (
  id            TEXT PRIMARY KEY,
  game_id       TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  faction_id    TEXT NOT NULL REFERENCES game_factions(id) ON DELETE CASCADE,
  ship_class    TEXT NOT NULL,          -- 'corvette'|'frigate'|'destroyer'|'freighter'
  name          TEXT NOT NULL,
  parts_json    TEXT,                   -- JSON array of part ids; NULL/[] = bare hull
  icon_variant  TEXT,                   -- 'A'..'F' or NULL for class default
  is_active     INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_ship_designs_faction
  ON game_ship_designs(game_id, faction_id, ship_class);

ALTER TABLE game_body_build_queue ADD COLUMN parts_json TEXT;
ALTER TABLE game_ships ADD COLUMN parts_json TEXT;
