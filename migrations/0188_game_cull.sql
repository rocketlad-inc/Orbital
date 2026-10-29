-- ============================================================
-- 0188 - Game culling: a game with no player action for 15 days is ended,
-- and so is a lobby nobody has touched for 15 days (worker/cull.js).
--
-- games.no_cull   1 = never cull this game. The frozen marketing showcase
--                 (Kai68RfB5BhV) feeds the landing page, the press kit, the
--                 OG card and the Play listing art, so it is marked here.
--                 Every other game reads 0 (cullable).
-- cull_log        the audit trail: one row per game ended or lobby closed,
--                 with the last activity the sweep saw and why.
--                 PRIMARY KEY (id, kind) so a repeat run cannot log twice.
-- cull_runs       one row per hourly sweep slot. The row IS the claim: the
--                 INSERT OR IGNORE that lands runs the sweep, so concurrent
--                 crons and cold isolates run it once. It doubles as the
--                 operator status (when it last ran and what it did).
--
-- Re-runnable: a repeat ADD COLUMN is skipped by the runner (duplicate
-- column), the UPDATE sets the same value, the CREATEs are IF NOT EXISTS.
-- ============================================================

ALTER TABLE games ADD COLUMN no_cull INTEGER NOT NULL DEFAULT 0;

UPDATE games SET no_cull = 1 WHERE id IN ('Kai68RfB5BhV', 'ij9VVSf4t5d4');

CREATE TABLE IF NOT EXISTS cull_log (
  id               TEXT NOT NULL,
  kind             TEXT NOT NULL,
  last_activity_ms INTEGER,
  culled_ms        INTEGER NOT NULL,
  reason           TEXT NOT NULL,
  PRIMARY KEY (id, kind)
);

CREATE TABLE IF NOT EXISTS cull_runs (
  slot_ms        INTEGER PRIMARY KEY,
  started_ms     INTEGER NOT NULL,
  finished_ms    INTEGER,
  games_ended    INTEGER NOT NULL DEFAULT 0,
  lobbies_closed INTEGER NOT NULL DEFAULT 0,
  games_left     INTEGER NOT NULL DEFAULT 0,
  lobbies_left   INTEGER NOT NULL DEFAULT 0,
  note           TEXT
);
