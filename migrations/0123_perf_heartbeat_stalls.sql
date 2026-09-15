-- Stall telemetry for the perf heartbeat.
--
-- Players in the 700-ship game reported input lag that the heartbeat
-- could not see: frame_p50/p95 are an EMA and gaps over 250 ms were
-- discarded as "tab hidden", which is exactly the shape a main-thread
-- stall has. The client now counts raw rAF gaps, long tasks and
-- input-to-paint latency per window (PerfHud.tsx). These columns store
-- them. All nullable: an older client simply leaves them empty.

ALTER TABLE perf_heartbeats ADD COLUMN raw_over50 INTEGER;
ALTER TABLE perf_heartbeats ADD COLUMN raw_over250 INTEGER;
ALTER TABLE perf_heartbeats ADD COLUMN raw_max_ms INTEGER;
ALTER TABLE perf_heartbeats ADD COLUMN longtask_n INTEGER;
ALTER TABLE perf_heartbeats ADD COLUMN longtask_ms INTEGER;
ALTER TABLE perf_heartbeats ADD COLUMN longtask_max_ms INTEGER;
ALTER TABLE perf_heartbeats ADD COLUMN input_n INTEGER;
ALTER TABLE perf_heartbeats ADD COLUMN input_p50 INTEGER;
ALTER TABLE perf_heartbeats ADD COLUMN input_max_ms INTEGER;
