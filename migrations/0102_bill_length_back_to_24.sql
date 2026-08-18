-- Slider laws stand 24 ticks again, not 48, INCLUDING the one already in
-- force. senate.js EFFECT_TICKS went 24 -> 48 as a side effect of
-- lengthening the vote window; 48 ticks is 48 hours at the 1h cadence
-- every live game runs, which is two full days of a law you may not want.
--
-- Normally a passed law keeps the term it was written with. This is an
-- explicit one-off correction of an over-crank, per Lorne, not a new rule.
--
-- SCOPING. The predicate is "longer than 24 ticks from where it started",
-- which by construction hits only the 48-tick laws — every earlier law was
-- written at 7 or 24 and is left exactly as it was. It can only ever
-- SHORTEN a law, never extend one, so re-running it is a no-op.
--
-- slider laws ONLY. The other bill kinds have their own durations
-- (trade_embargo 14, war_authorization 21, production_sanction 14) and
-- must not be touched -- hence the kind/effect_kind filters rather than a
-- blanket update.

-- The bill record.
UPDATE senate_proposals
   SET effect_until_tick = resolved_at_tick + 24
 WHERE kind = 'slider_law'
   AND resolved_at_tick IS NOT NULL
   AND effect_until_tick IS NOT NULL
   AND effect_until_tick > resolved_at_tick + 24;

-- The effect row runtime actually reads. Kept in lockstep with the bill:
-- leaving this at 48 would expire the law on paper while combat, harvest
-- and build costs went on applying it.
UPDATE senate_effects
   SET active_until_tick = active_from_tick + 24
 WHERE effect_kind = 'slider'
   AND active_until_tick > active_from_tick + 24;
