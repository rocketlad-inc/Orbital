-- ============================================================================
-- 0053: Spend-by-category telemetry
--
-- The yield-flow chart shows NET resource movement; balancing prices needs
-- to know WHERE the spend goes (ships vs buildings vs colonies vs
-- captains). One row per debiting player action, written by logSpend()
-- alongside the existing debit batch. Income is not logged here - it is
-- already derivable from faction_metrics deltas plus this table.
-- ============================================================================

CREATE TABLE spend_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id       TEXT NOT NULL,
  faction_id    TEXT,
  category      TEXT NOT NULL,       -- 'ships'|'buildings'|'colonies'|'captains'|...
  metal         INTEGER NOT NULL DEFAULT 0,
  gold          INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_spend_game ON spend_events(game_id, created_at_ms);
