-- 0106_perf_build_and_canvas.sql
--
-- Three columns that turn perf telemetry from "something is slow" into
-- "this build, at this zoom, holding this much canvas".
--
-- git_sha  WHICH BUILD. Neither perf table recorded one, so a sample
--          could not be attributed to a release. After shipping four
--          render fixes in a day the only honest answer to "did that
--          help" was "wait for another Discord report" -- the aggregates
--          mixed pre- and post-fix clients with no way to separate them.
--          One column ends that.
--
-- canvas_mb  OFFSCREEN CANVAS BYTES the renderer is holding. heap_mb is
--          NULL on every iOS sample because Safari does not expose
--          performance.memory, and iOS is exactly where the crashes were
--          reported -- so the one platform that crashed is the one
--          platform with no memory signal. Canvas bytes are countable in
--          JS on every browser, and canvas is what actually blew up: a
--          zoom sweep once left 513 MB of sphere-shade sprites resident.
--
-- zoom already exists on perf_heartbeats but has recorded literal 0 for
-- all 16,400 rows -- its call site passes `ships.length ? 0 : 0`. That is
-- fixed in the client, not here; no schema change needed.
--
-- Nullable + no backfill: old rows legitimately have no build stamp, and
-- inventing one would be worse than admitting it.
ALTER TABLE perf_heartbeats ADD COLUMN git_sha TEXT;
ALTER TABLE perf_heartbeats ADD COLUMN canvas_mb REAL;
ALTER TABLE perf_samples   ADD COLUMN git_sha TEXT;
ALTER TABLE perf_samples   ADD COLUMN canvas_mb REAL;
