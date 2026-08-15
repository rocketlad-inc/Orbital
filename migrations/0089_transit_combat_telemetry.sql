-- ============================================================
-- 0089 — shot-level telemetry for transit combat
--
-- Every balance number in DESIGN-combat-v2.md came from ~990,000
-- simulated battles, and that only worked because shot-level data was
-- recorded. Transit combat ships with V_REF explicitly UNTUNED — it was
-- carried over from a superseded model that measured total relative
-- speed, and the current model measures only the crossing component. So
-- stage 2 has a number to find, and this is what it finds it with.
--
-- WHY |w| AND w_t SEPARATELY, when one is derivable from the other only
-- with the geometry: because that separation IS the model. The whole
-- revision was splitting "how hard was it to aim" (crossing) from "how
-- long was it in range" (closing + speed). Recording only total relative
-- speed would leave stage 2 unable to tune the thing it is tuning.
--
-- One row per shot rather than a bucketed aggregate: transit shots are
-- rare by construction (a volley or two per transit, and only where
-- somebody was genuinely in range), so the volume is manageable and the
-- distribution is the interesting part.
-- ============================================================

CREATE TABLE IF NOT EXISTS game_transit_shots (
  id                  TEXT PRIMARY KEY,
  game_id             TEXT NOT NULL,
  tick_number         INTEGER NOT NULL,

  attacker_ship_id    TEXT NOT NULL,
  attacker_faction_id TEXT,
  attacker_class      TEXT,
  defender_ship_id    TEXT NOT NULL,
  defender_faction_id TEXT,
  defender_class      TEXT,

  -- Which party was actually flying. Both can be true (two ships that
  -- launched onto the same lane), and that pairing is the one the design
  -- expects to produce running fights.
  attacker_in_transit INTEGER NOT NULL DEFAULT 0,
  defender_in_transit INTEGER NOT NULL DEFAULT 0,

  d_min               REAL,     -- closest approach, world units
  dv                  REAL,     -- |w|, total relative speed
  w_t                 REAL,     -- crossing component — the aim input
  k_realised          REAL,     -- 1 + w_t/V_REF, as actually applied
  f_realised          REAL,     -- exposure: fraction of the tick in range
  p_hit               REAL,     -- the probability the roll was checked against
  landed              INTEGER NOT NULL DEFAULT 0,

  created_at_ms       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transit_shots_game
  ON game_transit_shots(game_id, tick_number);

-- ---------------------------------------------------------------
-- Fleet composition, sampled per faction per tick.
--
-- The first watch item on transit combat is CORVETTE MONOCULTURE:
-- speed's value is superlinear in relative motion, so the corvette's
-- edge over a destroyer runs 8:1 parked and 52:1 at cruise. That may be
-- the job the class has been missing (it measured 0.70 combat power per
-- credit against the destroyer's 9.44) or it may collapse fleet
-- composition to one hull.
--
-- You cannot tell which from hit rates. You can only tell from what
-- players BUILD after they learn the rule, which is why this is
-- sampled alongside the shots rather than derived from them.
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS game_fleet_composition (
  game_id       TEXT NOT NULL,
  faction_id    TEXT NOT NULL,
  tick_number   INTEGER NOT NULL,
  corvettes     INTEGER NOT NULL DEFAULT 0,
  frigates      INTEGER NOT NULL DEFAULT 0,
  destroyers    INTEGER NOT NULL DEFAULT 0,
  freighters    INTEGER NOT NULL DEFAULT 0,
  colonies      INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (game_id, faction_id, tick_number)
);
