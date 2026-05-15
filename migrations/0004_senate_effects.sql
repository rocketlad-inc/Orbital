-- ============================================================================
-- Orbital — Senate Effects (v1)
-- ============================================================================
--
-- Adds the deferred-application table for senate slider laws. When a senate
-- proposal passes, the resolver inserts a row here with the slider id, the
-- chosen value, and the active tick window. Other systems (tick processor,
-- build cost calc, fuel yield, combat) read this table to compute the
-- effective slider value for a given (game_id, slider_id, current_tick).
--
-- The slider catalog itself (id, label, range, default) lives in worker
-- code (`src/senate.js`); this table holds only the per-game active overrides.
-- ============================================================================

CREATE TABLE senate_effects (
  id                 TEXT PRIMARY KEY,
  game_id            TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  slider_id          TEXT NOT NULL,
  value              REAL NOT NULL,
  proposal_id        TEXT REFERENCES senate_proposals(id) ON DELETE SET NULL,
  active_from_tick   INTEGER NOT NULL,
  active_until_tick  INTEGER NOT NULL,
  created_at_tick    INTEGER NOT NULL,
  created_at_ms      INTEGER NOT NULL
);

-- Most-recent active effect lookup: "for game G, slider S, at tick T, what's
-- the effect row where active_from_tick <= T < active_until_tick?".
CREATE INDEX idx_senate_effects_lookup
  ON senate_effects(game_id, slider_id, active_until_tick, active_from_tick);

CREATE INDEX idx_senate_effects_game ON senate_effects(game_id);
