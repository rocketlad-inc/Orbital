-- ============================================================
-- 0087 — a per-tick economic ledger, so the Economy tab has a past
--
-- There was no history to chart. game_snapshots exists but has never
-- held a row, and spend_events only records money going OUT (and only
-- from player actions, timestamped in wall-clock ms rather than ticks).
-- Nothing anywhere recorded what an empire EARNED, so "show me the trend"
-- had nothing to draw.
--
-- One row per faction per tick, written at the end of resolveTick.
--
-- WHY LEVELS PLUS UPKEEP, rather than an income column: income is
-- computed across several passes (settlement yield, trade deliveries,
-- terraform refunds, salvage) and threading an accumulator through all of
-- them is a lot of edit surface for a number that can be derived exactly.
-- Given consecutive rows:
--
--     income = (pool_now - pool_prev) + upkeep_charged + spending
--
-- ...which the endpoint reconstructs. The ledger stays a dumb recording
-- of observable state, so it cannot drift from the rules the way a
-- hand-maintained income counter would.
--
-- Arrears ride along because an empire that cannot pay its fleet is the
-- single most important thing an economy screen should be shouting about.
-- ============================================================

CREATE TABLE IF NOT EXISTS faction_economy_ticks (
  game_id        TEXT    NOT NULL,
  faction_id     TEXT    NOT NULL,
  tick_number    INTEGER NOT NULL,

  -- End-of-tick pool levels.
  pool_metal     REAL    NOT NULL DEFAULT 0,
  pool_gold      REAL    NOT NULL DEFAULT 0,
  pool_science   REAL    NOT NULL DEFAULT 0,

  -- Charged this tick by the fleet-upkeep pass.
  upkeep_metal   REAL    NOT NULL DEFAULT 0,
  upkeep_gold    REAL    NOT NULL DEFAULT 0,

  -- Still owed after the settle — a fleet in arrears fights at a penalty.
  arrears_metal  REAL    NOT NULL DEFAULT 0,
  arrears_gold   REAL    NOT NULL DEFAULT 0,

  created_at_ms  INTEGER NOT NULL,

  PRIMARY KEY (game_id, faction_id, tick_number)
);

-- The Economy tab reads one faction's series newest-first.
CREATE INDEX IF NOT EXISTS idx_econ_faction_tick
  ON faction_economy_ticks (game_id, faction_id, tick_number DESC);
