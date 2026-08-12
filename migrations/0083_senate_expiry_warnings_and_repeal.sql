-- ============================================================
-- 0083 — law-expiry warnings, and repeal bookkeeping
--
-- Two features, one table.
--
-- 1) EXPIRY WARNINGS. Laws now stand for 24 ticks (was 7), which at an
--    hour per tick is a day of real time — long enough that "my law is
--    about to lapse" is genuinely useful news and short enough that
--    missing it costs you the policy. The chamber already announces a
--    law ARRIVING and LAPSING; these two stamps let it warn beforehand,
--    once each, at roughly four hours and one hour of WALL CLOCK before
--    the window closes (wall clock, not ticks, because tick_interval_ms
--    is per-game and a "4 hour warning" measured in ticks would mean
--    something different in every lobby).
--
--    Same once-only pattern as expiry_logged_at_tick from 0081: the
--    sender stamps AFTER a successful post, so a failed post retries on
--    the next tick instead of being silently marked as delivered. NULL
--    means "not warned yet".
--
--    Backfilled to the resolved tick for laws that ALREADY lapsed, so
--    this never fires a retroactive warning about a dead law on the
--    first tick after deploy. Same guard 0081 used for its own stamp.
--
-- 2) REPEAL. A repeal bill ends a standing law early, which needs to be
--    distinguishable from the law simply running its course — for the
--    Herald's prose, for the analytics tab, and so the generic "lapsed"
--    card can't also fire for a law the chamber deliberately struck
--    down. NULL = ran its course (or still standing).
-- ============================================================

ALTER TABLE senate_proposals ADD COLUMN warn_4h_logged_at_tick INTEGER;
ALTER TABLE senate_proposals ADD COLUMN warn_1h_logged_at_tick INTEGER;
ALTER TABLE senate_proposals ADD COLUMN repealed_at_tick INTEGER;

-- Don't warn about laws that are already over. Stamp both windows on
-- anything whose effect window has closed; live laws stay NULL and get
-- their warnings normally.
UPDATE senate_proposals
   SET warn_4h_logged_at_tick = COALESCE(resolved_at_tick, 0),
       warn_1h_logged_at_tick = COALESCE(resolved_at_tick, 0)
 WHERE status = 'passed'
   AND effect_until_tick IS NOT NULL
   AND expiry_logged_at_tick IS NOT NULL
   AND warn_4h_logged_at_tick IS NULL;

-- The warning sweep looks for passed laws still in force with an unsent
-- stamp; index it the same shape as 0081's expiry index.
CREATE INDEX IF NOT EXISTS idx_senate_proposals_warn
  ON senate_proposals(game_id, status, effect_until_tick,
                      warn_4h_logged_at_tick, warn_1h_logged_at_tick);
