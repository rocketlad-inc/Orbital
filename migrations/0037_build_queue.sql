-- Unlimited build queue (DESIGN-identity-economy.md §7 P1c).
--
-- Before: handleQueueBuild 409'd ('no_slots') once in-flight builds at
-- a body reached concurrency = 1 + shipyard levels. Now any number of
-- orders can be queued (resources still charged at queue time); orders
-- beyond capacity wait with status='waiting' and are promoted FIFO by
-- the tick alarm as active builds complete.
--
-- Columns (all additive; SQLite constant DEFAULT backfills existing
-- rows, so every pre-migration row reads status='building' — correct,
-- they were all active under the old gate):
--
--   status          'building' (counts against slots, tick alarm
--                   completes it at completes_at_tick) or 'waiting'
--                   (inert until promoted; its completes_at_tick is a
--                   placeholder and is rewritten at promotion).
--   build_ticks     construction duration snapshot taken at queue time
--                   so promotion doesn't have to re-derive it from the
--                   ship class table. NULL on legacy rows — promotion
--                   falls back to SHIP_BUILD_COST[ship_class].
--   started_at_tick tick the build actually became active (insert time
--                   when a slot was free, promotion time otherwise).
--                   NULL on legacy + waiting rows; the client falls
--                   back to queued_at_tick for the progress bar.
ALTER TABLE game_body_build_queue ADD COLUMN status TEXT NOT NULL DEFAULT 'building';
ALTER TABLE game_body_build_queue ADD COLUMN build_ticks INTEGER;
ALTER TABLE game_body_build_queue ADD COLUMN started_at_tick INTEGER;
