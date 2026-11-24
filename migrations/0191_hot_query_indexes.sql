-- Indexes for the two hottest D1 reads (Cloudflare invoice 2026-11-24: $471 of rows read).
--
-- turnDigest reads faction_economy_ticks by (game_id, tick_number). The only index led
-- (game_id, faction_id, tick_number), so every lookup scanned the game's whole ledger:
-- ~550k rows per call on staging, growing every tick.
CREATE INDEX IF NOT EXISTS idx_econ_game_tick ON faction_economy_ticks (game_id, tick_number);

-- The build queue had no full index leading with game_id (idx_build_queue_completion is
-- partial and keyed on completes_at_tick), so the per-tick "waiting"/"building" lookups
-- and the ship-name UNION scanned the whole table.
CREATE INDEX IF NOT EXISTS idx_build_queue_game_status
  ON game_body_build_queue (game_id, status, body_id, faction_id);
