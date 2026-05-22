-- Freighter trade-route completion counter.
--
-- Every time a freighter on an active trade route reaches the dest
-- body with cargo and dumps it into the faction pool, this counter
-- bumps by 1. The ShipPanel "Combat Record" section is replaced with
-- a "Trade Log" view for freighters — they're hauling cargo, not
-- killing things, so showing 0 confirmed kills was a category error.
--
-- Defaulted to 0 so existing freighters backfill cleanly with no
-- migration write. Capped per-faction-per-game in practice (no hard
-- ceiling); a 4000-tick game with one freighter cycling Earth↔Mars
-- (~10 ticks per leg) can rack up ~400 deliveries — still fits in
-- INTEGER comfortably.

ALTER TABLE game_ships ADD COLUMN trades_completed INTEGER NOT NULL DEFAULT 0;
