-- ============================================================
-- Megastructures — enormous projects built by running cargo to a
-- framework parked in open space.
--
-- A SITE IS A BODY. The row that holds a site's position is a normal
-- game_bodies row with type 'megastructure'. That is not a shortcut, it
-- is the whole reason this is affordable: bodies already have a parent,
-- an orbit, an owner, a radius and an SOI, and every system downstream
-- already knows how to place them, draw them, decide whether you can
-- see them, and accept them as a trade-route destination. Meteoroids
-- were added the same way and for the same reason.
--
-- This table is only the part a body cannot express: what is being
-- built, how far along it is, and who it is wired to.
-- ============================================================

CREATE TABLE game_megastructures (
  -- The game_bodies row that carries position, orbit and ownership.
  body_id        TEXT PRIMARY KEY REFERENCES game_bodies(id) ON DELETE CASCADE,
  game_id        TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,

  -- 'warp_gate' | 'weapons_station' | 'gravity_sink' | 'deep_array'
  -- | 'null_field' | 'mega_destroyer' | 'mobile_foundry'
  kind           TEXT NOT NULL,
  -- 'building' | 'complete'. A destroyed site deletes its body row and
  -- cascades away; there is no 'destroyed' state to filter on.
  status         TEXT NOT NULL DEFAULT 'building',

  -- Cargo banked so far. REAL because capture multiplies these by 0.7
  -- and rounding a scaled bucket at every capture would leak progress.
  acc_metal      REAL NOT NULL DEFAULT 0,
  acc_credits    REAL NOT NULL DEFAULT 0,

  -- THE BILL IS SNAPSHOT AT PLACEMENT. Costs come from per-game config,
  -- and config can be republished mid-match. Reading the live number
  -- every tick would move the goalposts under a convoy already running.
  cost_metal     INTEGER NOT NULL,
  cost_credits   INTEGER NOT NULL,

  -- Warp gates only: the other end. Exactly one partner, both ways.
  -- Self-referential rather than a link table because the cardinality
  -- IS one — a link table would permit a shape the rules forbid.
  partner_body_id TEXT REFERENCES game_bodies(id) ON DELETE SET NULL,

  -- Per-kind state that does not deserve a column: the gravity sink's
  -- pass list, the weapons station's tier. JSON so a new structure does
  -- not need a migration to hold one number.
  settings_json  TEXT,

  -- Who laid the foundation, as distinct from game_bodies.owner_faction_id,
  -- which changes hands on capture. Kept so the chronicle can say whose
  -- work was taken.
  founded_by_faction_id TEXT REFERENCES game_factions(id) ON DELETE SET NULL,
  founded_at_tick   INTEGER NOT NULL,
  completed_at_tick INTEGER,
  captured_at_tick  INTEGER
);

CREATE INDEX idx_mega_game ON game_megastructures(game_id);
CREATE INDEX idx_mega_status ON game_megastructures(game_id, status);
CREATE INDEX idx_mega_partner ON game_megastructures(partner_body_id);

-- Trade routes already carry a `kind` ('haul', 'terraform', ...). A
-- megastructure delivery is 'megastructure' and targets the site's body
-- id through the existing dest_body_id, so no route schema changes.
