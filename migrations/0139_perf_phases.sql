-- Per-phase map draw timing on perf heartbeats: JSON {phase: [p50_ms, p95_ms]}.
-- draw_p50 could say a frame cost 211ms but not which part of the frame
-- (2026-09-23, a player at 4 fps with 415 hulls in transit).
ALTER TABLE perf_heartbeats ADD COLUMN phases TEXT;
