-- ============================================================================
-- Explicit captain bench (2026-07-28, Lorne playtest).
--
-- ensureCaptains (worker/captains.js) runs every tick and posts the
-- longest-waiting bank captain onto any captainless same-faction ship,
-- preferring combat hulls, otherwise at random. That is the intended
-- distribution behavior for a NEW hull (0050's "bank-pull only" note) —
-- but it also silently undid a deliberate bench: with 10 captains and
-- 19+ ships there is always an orphan hull to soak one up, so "→ To the
-- bank" bounced the captain straight back onto a random ship within one
-- tick, and a swap re-posted the displaced captain somewhere arbitrary.
--
-- benched_at_tick records a PLAYER decision to hold a captain in reserve.
-- ensureCaptains skips those; assigning to a ship clears it. NULL means
-- "arrived in the bank on its own" (starting allotment, a fresh recruit,
-- or a rescue) and stays auto-assignable, preserving today's behavior for
-- every captain currently in a live game.
-- ============================================================================

ALTER TABLE game_captains ADD COLUMN benched_at_tick INTEGER;
