-- ============================================================
-- 0174 - the Commission thank-you card is asked once, really
--
-- Until 2026-10-19 the card came back on every visit until the player
-- answered it (18 players saw it 253 times; one saw it 60 times). The
-- server now records the showing itself (worker/commissionAsk.js).
-- Everyone who has already seen it without answering is marked as
-- asked, so nobody sees it again.
--
-- Idempotent: only rows still unmarked are touched, so a rerun changes
-- nothing (data migrations have run more than once before, see 0172).
-- ============================================================

UPDATE users
   SET commission_ask_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
       commission_ask_action = 'shown'
 WHERE commission_ask_ms IS NULL
   AND id IN (SELECT DISTINCT user_id FROM analytics_events
               WHERE kind = 'ui/commission-view'
                 AND user_id IS NOT NULL
                 AND json_extract(payload, '$.from') = 'thanks-card');
