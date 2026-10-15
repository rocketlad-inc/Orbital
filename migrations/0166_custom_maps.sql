-- The Map Maker (Lorne, 2026-10-14): player-built star systems.
--
-- custom_maps holds each player's maps as the JSON the Map Maker edits
-- (src/game/customMap.js normalizeMap is the format). share_code lets
-- anyone open a copy of a map; copied_from records where a copy came from.
CREATE TABLE IF NOT EXISTS custom_maps (
  id            TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  map_json      TEXT NOT NULL,
  share_code    TEXT NOT NULL UNIQUE,
  copied_from   TEXT,
  hosted_count  INTEGER NOT NULL DEFAULT 0,
  created_ms    INTEGER NOT NULL,
  updated_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_custom_maps_owner ON custom_maps(owner_user_id, updated_ms);

-- A room hosted on a custom map carries a SNAPSHOT of it, taken when it
-- was hosted: editing the map afterwards never changes a game already set
-- up. seedGameWorld builds the system from the snapshot.
ALTER TABLE rooms ADD COLUMN custom_map_id TEXT;
ALTER TABLE rooms ADD COLUMN custom_map_json TEXT;

-- A custom world's look: {surface, rings} for a world, {star} for a sun.
-- Shipped worlds have their own art keyed on their template id and leave
-- this NULL.
ALTER TABLE game_bodies ADD COLUMN look_json TEXT;
