-- Theatres: a fight at Phobos and a fight at Mars are the same fight.
--
-- A battle is one body plus a contiguous run of ticks, which is the grain
-- a player remembers a single engagement at. It is NOT the grain they
-- remember a war at. When a fleet works its way through Mars, Phobos and
-- Deimos over twenty ticks, the records hold three unrelated battles and
-- nothing anywhere says they were one campaign -- so the analytics list
-- reads as three skirmishes and the Herald reports them as three
-- unconnected items on the same day.
--
-- A THEATRE groups battles by the planetary neighbourhood they were
-- fought in: the body that orbits the star, plus everything orbiting
-- that. Mars and its moons are one theatre; Jupiter and its moons are
-- another. The anchor is found by walking parent_body_id up until the
-- next step would be the star, so it needs no configuration and no list
-- of systems to maintain — it falls out of the map the game already has.
--
-- Grouping is by PLACE, not by belligerents. Two factions fighting at
-- Mars while two others fight at Phobos is still one theatre, because
-- that is what "the Mars system is at war" means, and because the fleets
-- involved can and do move between those bodies mid-campaign.
--
-- A theatre closes when the last battle inside it does, so the same quiet
-- window that keeps one engagement together across a lull keeps a
-- campaign together across a body being taken.

CREATE TABLE IF NOT EXISTS battle_theatres (
  id                TEXT PRIMARY KEY,
  game_id           TEXT NOT NULL,
  -- The body under the star that the whole neighbourhood hangs off.
  anchor_body_id    TEXT,
  anchor_name       TEXT,

  started_tick      INTEGER NOT NULL,
  last_fire_tick    INTEGER NOT NULL,
  ended_tick        INTEGER,
  started_at_ms     INTEGER NOT NULL,
  closed_at_ms      INTEGER,
  status            TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'ended'

  -- Rollups across every battle in the theatre, maintained as it runs so
  -- a list view needs no joins.
  battle_count      INTEGER NOT NULL DEFAULT 0,
  body_ids          TEXT,                             -- JSON array
  faction_ids       TEXT,                             -- JSON array
  shots             INTEGER NOT NULL DEFAULT 0,
  hits              INTEGER NOT NULL DEFAULT 0,
  damage            REAL    NOT NULL DEFAULT 0,
  ships_lost        INTEGER NOT NULL DEFAULT 0,
  settlements_lost  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_theatres_game ON battle_theatres(game_id, status);
CREATE INDEX IF NOT EXISTS idx_theatres_anchor
  ON battle_theatres(game_id, anchor_body_id, status);

-- Which campaign each engagement belongs to. Null for battles recorded
-- before theatres existed, and for anything with no body at all.
ALTER TABLE battles ADD COLUMN theatre_id TEXT;
CREATE INDEX IF NOT EXISTS idx_battles_theatre ON battles(theatre_id);
