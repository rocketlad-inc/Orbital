-- ============================================================================
-- Captain reset: wipe the auto-mint era, start everyone at the 10-captain
-- allotment (2026-07-28, Lorne).
--
-- The old ensureCaptains minted a free captain for every hull, so live games
-- carry one captain per ship (46+ in the big game). With captains now a
-- finite resource (STARTING_CAPTAINS=10 + paid recruits), existing games
-- keep an inventory the new economy would never have produced.
--
-- This deletes EVERY captain and detaches them from ships and fleet flags.
-- On each game's next tick, ensureCaptainFloor re-rolls a fresh 10 per
-- faction and ensureCaptains assigns them to captainless COMBAT ships in
-- random order (bank-pull only). Every ship beyond those ten sails
-- uncommanded — by design: no trait, no rank growth, no fleet flag.
--
-- Cost accepted knowingly: captain rank/kill history from the free era is
-- erased. Ship-side legacy rank columns are untouched, so hull veterancy
-- survives where it was ever recorded.
-- ============================================================================

DELETE FROM game_captains;
UPDATE game_ships  SET captain_id = NULL WHERE captain_id IS NOT NULL;
UPDATE game_fleets SET flag_captain_id = NULL WHERE flag_captain_id IS NOT NULL;
