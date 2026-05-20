-- Collector network endpoint flag for settlements.
--
-- A collector is a logistics endpoint that lets stockpile drain to the
-- empire pool. Without one, every settlement piles resources locally
-- with nowhere to land. Capitals start with one (set in
-- worker/factions.js seedGameWorld); every other has to be built via
-- POST /api/games/:gameId/settlements/:settlementId/collector.
--
-- Tracked tick-of-construction is informational only — surfaces in the
-- BodyInspector as "built T+123". NULL on the free capital collector
-- so the UI can distinguish "starter" from "built-by-the-player."

ALTER TABLE game_settlements ADD COLUMN has_collector INTEGER NOT NULL DEFAULT 0;
ALTER TABLE game_settlements ADD COLUMN collector_built_tick INTEGER;
