-- Cities + orbital stations mirrored to D1 so the multiplayer canvas
-- can paint them server-authoritatively (and so the tick resolver can
-- harvest yields into settlement stockpiles).
--
-- type = 'city' has surface_angle (radians around body's surface).
-- type = 'station' has orbit_* elements (Keplerian orbit around body).
-- The columns the wrong type doesn't need are simply NULL.

CREATE TABLE game_settlements (
  id                  TEXT PRIMARY KEY,
  game_id             TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  body_id             TEXT NOT NULL REFERENCES game_bodies(id) ON DELETE CASCADE,
  owner_faction_id    TEXT NOT NULL REFERENCES game_factions(id) ON DELETE CASCADE,
  type                TEXT NOT NULL,          -- 'city' | 'station'
  name                TEXT NOT NULL,
  hp                  REAL NOT NULL,
  hp_max              REAL NOT NULL,
  population          INTEGER NOT NULL DEFAULT 1,
  -- surface placement (city) or orbit (station)
  surface_angle       REAL,
  orbit_rp            REAL,
  orbit_ra            REAL,
  orbit_omega         REAL,
  orbit_m0            REAL,
  orbit_epoch         REAL,
  -- per-settlement stockpile (matches game_factions resource columns)
  stockpile_metal     INTEGER NOT NULL DEFAULT 0,
  stockpile_fuel      INTEGER NOT NULL DEFAULT 0,
  stockpile_gold      INTEGER NOT NULL DEFAULT 0,
  stockpile_science   INTEGER NOT NULL DEFAULT 0,
  -- lifecycle
  created_at_tick     INTEGER NOT NULL,
  last_growth_tick    INTEGER,
  last_harvest_tick   INTEGER,
  last_combat_tick    INTEGER,
  destroyed_at_tick   INTEGER
);

CREATE INDEX idx_settlements_game ON game_settlements(game_id);
CREATE INDEX idx_settlements_body ON game_settlements(body_id);
CREATE INDEX idx_settlements_owner ON game_settlements(owner_faction_id);
