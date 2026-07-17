-- 0034_discord_digest_state.sql
--
-- Bookkeeping for the daily Discord digest (worker/digest.js). One row
-- per game tracking:
--   last_digest_ms    — wall-clock of the last digest sent (gate: don't
--                       send twice in one day even if the cron re-fires)
--   last_entry_ms     — created_at_ms high-water mark of chronicle
--                       entries already reported, so each digest covers
--                       exactly the window since the previous one
--   trades_snapshot   — SUM(game_ships.trades_completed) at last digest;
--                       the delta against the live sum = "deliveries
--                       completed today"
--
-- No row = game has never been digested; the first run backfills with
-- a 24h lookback rather than the whole game history.

CREATE TABLE IF NOT EXISTS digest_state (
  game_id          TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  last_digest_ms   INTEGER NOT NULL DEFAULT 0,
  last_entry_ms    INTEGER NOT NULL DEFAULT 0,
  trades_snapshot  INTEGER NOT NULL DEFAULT 0
);
