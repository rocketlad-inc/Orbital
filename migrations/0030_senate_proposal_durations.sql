-- ============================================================================
-- 0030 — Per-proposal debate and vote durations
-- ============================================================================
--
-- The Senate had hardcoded DEBATE_TICKS=2 and VOTE_TICKS=1 in worker/senate.js.
-- For production the proposer needs to control deliberation length per proposal
-- (a routine slider change can ratify quickly; a controversial one wants time
-- for discussion). Both columns are nullable so legacy proposals fall back to
-- the constants when the server reads them; new rows record the values that
-- were actually used so the UI can show "debate: 6 ticks" without having to
-- guess.
-- ============================================================================

ALTER TABLE senate_proposals ADD COLUMN debate_ticks INTEGER;
ALTER TABLE senate_proposals ADD COLUMN vote_ticks   INTEGER;
