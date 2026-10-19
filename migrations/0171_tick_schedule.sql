-- ============================================================
-- 0171 — a game's tick speed by time of day (worker/tickSchedule.js).
--
-- Players asked for it again and again (Moitão, 2026-10-05 and 10-09):
-- 30-minute ticks while everyone is awake, slower ticks overnight, so the
-- game moves faster by day and nobody wins by staying up.
--
-- JSON, NULL = one flat speed (tick_interval_ms, as before):
--   { "tz": "America/Sao_Paulo",
--     "periods": [ { "at": "08:00", "interval_ms": 1800000 },
--                  { "at": "00:00", "interval_ms": 3600000 } ] }
-- Each period runs from its "at" until the next one's, wrapping at
-- midnight. tick_interval_ms keeps holding the speed IN FORCE, rewritten
-- each tick, so everything that reads it carries on unchanged.
-- ============================================================

ALTER TABLE games ADD COLUMN tick_schedule TEXT;
