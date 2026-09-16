-- Where a hull runs to.
--
-- Auto-retreat sent every ship to the NEAREST friendly shipyard, and
-- nothing recorded which yard built a hull. Two columns:
--
--   home_body_id     the body the hull was built at. Stamped at every
--                    spawn from now on; backfilled below for hulls that
--                    already exist. The DEFAULT retreat destination.
--   retreat_body_id  a yard the player picked for this hull, or NULL for
--                    "home". Overrides home while a living station of
--                    theirs still stands there.
--
-- Resolution at retreat time (room.js): chosen -> home -> nearest, each
-- only while a friendly station is still alive at that body, so a
-- razed home yard degrades to the old behaviour rather than to nowhere.

ALTER TABLE game_ships ADD COLUMN home_body_id TEXT;
ALTER TABLE game_ships ADD COLUMN retreat_body_id TEXT;

-- Backfill 1: built hulls have a ship_built chronicle stamped with the
-- yard body (1,267 of 1,339 live hulls on prod at time of writing).
UPDATE game_ships
   SET home_body_id = (SELECT c.body_id FROM chronicle_entries c
                        WHERE c.kind = 'ship_built' AND c.ship_id = game_ships.id
                          AND c.body_id IS NOT NULL
                        ORDER BY c.tick_number ASC LIMIT 1)
 WHERE home_body_id IS NULL;

-- Backfill 2: starter fleets were seeded at tick 0 around the capital.
UPDATE game_ships
   SET home_body_id = (SELECT f.capital_body_id FROM game_factions f
                        WHERE f.id = game_ships.owner_faction_id)
 WHERE home_body_id IS NULL AND built_at_tick = 0;
