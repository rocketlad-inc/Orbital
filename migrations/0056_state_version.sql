-- ============================================================================
-- 0056: Monotonic per-game state version
--
-- /state assembly costs ~500ms in a 229-ship game (measured: ~15 D1
-- round-trips that barely parallelize), and it is the floor under every
-- click's response time. But between a tick and the next player action
-- the assembled payload is BYTE-IDENTICAL poll after poll (verified
-- live) - so cache it. The version bumps at the request choke point on
-- every mutating game action; the cache key is
-- (game, faction, state_version, current_tick), so ticks invalidate via
-- the tick number and actions via this counter. A spurious bump is a
-- harmless cache miss; a missed bump would be stale state, which is why
-- the bump lives at the dispatch choke point rather than in handlers.
-- ============================================================================

ALTER TABLE games ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0;
