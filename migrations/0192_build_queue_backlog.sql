-- Computer empires' runaway build backlog (Nov 2026 D1 bill, follow-up to 0191).
--
-- A full yard queues an order as 'waiting' instead of refusing it, and the solo
-- bots (aiEmpire.js) ordered up to five hulls every few ticks with no cap: prod
-- solo games held 22,488 / 16,177 / 4,868 waiting orders, re-read every tick.
-- aiEmpire.js now keeps at most MAX_WAITING_ORDERS (2) waiting per yard.
--
-- 1. Live-only index: a cancelled order keeps status 'waiting', so without the
--    partial index the hot "waiting"/"building" lookups still read every
--    cancelled row. Every hot lookup filters cancelled_at_tick IS NULL.
CREATE INDEX IF NOT EXISTS idx_build_queue_live
  ON game_body_build_queue (game_id, status, body_id, faction_id)
  WHERE cancelled_at_tick IS NULL;

-- 2. Cancel the stuck backlog of COMPUTER empires in ACTIVE games, keeping the
--    two oldest waiting orders per empire per yard (what the new cap keeps), so
--    each yard builds exactly as before. No refund: these orders could never
--    have reached the front of the queue. People's orders are not touched.
--    Idempotent: a second run finds nothing past the first two.
UPDATE game_body_build_queue
   SET cancelled_at_tick = (SELECT g.current_tick FROM games g WHERE g.id = game_body_build_queue.game_id)
 WHERE status = 'waiting'
   AND cancelled_at_tick IS NULL
   AND game_id IN (SELECT id FROM games WHERE status = 'active')
   AND faction_id IN (SELECT id FROM game_factions WHERE ai_doctrine IS NOT NULL)
   AND id NOT IN (
     SELECT id FROM (
       SELECT id, ROW_NUMBER() OVER (PARTITION BY game_id, faction_id, body_id ORDER BY queued_at_tick, id) AS rn
         FROM game_body_build_queue
        WHERE status = 'waiting' AND cancelled_at_tick IS NULL
     ) WHERE rn <= 2
   );
