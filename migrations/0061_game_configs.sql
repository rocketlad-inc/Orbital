-- ============================================================================
-- 0061: editable game configuration — drafts, publishing, test games
--
-- Every balance number in Orbital has lived as a module-level const, which
-- means changing one has always required me: edit, build, deploy. That is
-- a bad loop for balance work, where the whole job is trying a value,
-- watching what happens, and trying another.
--
-- A config is a sparse JSON object of OVERRIDES over the schema defaults
-- in worker/configSchema.js. Sparse matters: a draft that only touches
-- mint_per_level stays one key wide, so a later change to any other
-- default flows through instead of being frozen at whatever it was the
-- day the draft was saved.
--
-- status:
--   'draft'     — editable, launchable as a test game, invisible to players
--   'published' — the config new games are created with
--   'archived'  — was published once; kept because games still point at it
--
-- GAMES PIN THEIR CONFIG. games.config_id is captured at creation and
-- never rewritten, so publishing a change cannot alter the rules of a
-- match already in progress. That was the explicit call: new games only.
-- It also means an archived config must survive forever — a running game
-- referencing a deleted row would fall back to defaults mid-match and
-- silently rebalance itself.
-- ============================================================================

CREATE TABLE game_configs (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft',   -- draft | published | archived
  -- Sparse overrides only. {} is a perfectly valid config meaning
  -- "everything as shipped".
  overrides     TEXT NOT NULL DEFAULT '{}',
  notes         TEXT,
  -- Where this draft came from, so the editor can show a lineage and diff
  -- against the thing it was branched from.
  parent_id     TEXT,
  created_by    TEXT,
  created_ms    INTEGER NOT NULL,
  updated_ms    INTEGER NOT NULL,
  published_ms  INTEGER
);

CREATE INDEX idx_configs_status ON game_configs(status, updated_ms DESC);

-- Nullable: every existing game keeps NULL and resolves to schema
-- defaults, which is exactly the behaviour it has today.
ALTER TABLE games ADD COLUMN config_id TEXT;

-- Marks a game launched from a draft for testing, so the lobby can badge
-- it and analytics can exclude it from real-player statistics.
ALTER TABLE games ADD COLUMN is_test_game INTEGER NOT NULL DEFAULT 0;
