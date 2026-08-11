-- Announce a law LAPSING, not just a bill passing.
--
-- A passed bill parks `effect_until_tick` and its modifier then applies
-- for as long as every read filters `active_until_tick > tick`. Nothing
-- ever expired it: the law simply stopped matching the query one tick,
-- silently and forever. A tariff that had been shaping the economy for
-- its whole run just stopped, with no card, no Herald line, and nothing
-- in the chronicle — which reads as a bug rather than a rule.
--
-- WHY A COLUMN AND NOT `effect_until_tick = tick`.
-- resolveSenate can be handed a CATCH-UP batch (the DO resolves every
-- tick up to and including the current one after an idle stretch), so an
-- equality test would skip the announcement whenever a law lapsed inside
-- a tick that was fast-forwarded. This stamps when the expiry was
-- announced, so the sweep is `effect_until_tick <= tick AND
-- expiry_logged_at_tick IS NULL` — fires exactly once, no matter how the
-- ticks arrive, and is idempotent if the pass runs twice.
ALTER TABLE senate_proposals ADD COLUMN expiry_logged_at_tick INTEGER;

-- Backfill: laws that ALREADY lapsed before this migration are marked
-- announced, so the first tick after deploy doesn't dump one card per
-- historical law into every live game's feed at once.
--
-- The `effect_until_tick <= games.current_tick` clause is load-bearing.
-- Stamping every passed bill would also silence the laws still running
-- right now, and those are precisely the ones whose expiry players are
-- waiting on — the feature would ship dead in exactly the games that
-- have laws in flight.
UPDATE senate_proposals
   SET expiry_logged_at_tick = resolved_at_tick
 WHERE status = 'passed'
   AND effect_until_tick IS NOT NULL
   AND expiry_logged_at_tick IS NULL
   AND effect_until_tick <= (
     SELECT g.current_tick FROM games g WHERE g.id = senate_proposals.game_id
   );

CREATE INDEX IF NOT EXISTS idx_senate_expiry
  ON senate_proposals(game_id, status, effect_until_tick, expiry_logged_at_tick);
