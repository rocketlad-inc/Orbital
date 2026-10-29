-- THE THREE BODY EVENT (worker/invasion.js).
--
-- One row per game that has the event. Everything the phases need to
-- resume after a restart lives here, so the tick keeps no state of its
-- own: advanceInvasion reads this row, decides, writes it back.
--
--   start_tick     the seeded tick the science blight begins
--   phase          pending | blight | transit | siege | build | earth |
--                  conquest | repelled | done
--   phase_tick     the tick the current phase began
--   faction_id     the invaders' monster-status faction
--   site_body_id   where the fleet is going (a point on Sol's right side)
--   arrive_tick    when the fleet lands there
--   gate_body_id   the Sol end of the gate it lays; twin_body_id the other
--   target_body_id the world being assaulted now
--   held_body_id   the first world they took (their base)
--   built          hulls the invaders have raised since landing
--   taken_json     names of the worlds they hold, in order

CREATE TABLE IF NOT EXISTS game_invasion (
  game_id        TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  start_tick     INTEGER NOT NULL,
  phase          TEXT NOT NULL DEFAULT 'pending',
  phase_tick     INTEGER NOT NULL DEFAULT 0,
  faction_id     TEXT,
  site_body_id   TEXT,
  arrive_tick    INTEGER,
  gate_body_id   TEXT,
  twin_body_id   TEXT,
  target_body_id TEXT,
  held_body_id   TEXT,
  built          INTEGER NOT NULL DEFAULT 0,
  taken_json     TEXT NOT NULL DEFAULT '[]'
);
