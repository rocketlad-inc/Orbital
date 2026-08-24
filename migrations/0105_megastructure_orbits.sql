-- ============================================================
-- Make ships orbit a megastructure the way they orbit a world.
--
-- Two things were wrong, and only together did they show.
--
-- MU WAS ZERO. Sites were inserted with mu = 0, and orbited at all only
-- because muOf falls through to 100 for an unrecognised body type — the
-- right number by accident, which is the kind of thing that changes the
-- first time somebody tidies a default. Set explicitly now.
--
-- EVERY HULL PARKED ON THE SAME POINT. Arrival wrote orbit_m0 = 0 for
-- every ship at every body. Around a planet that mostly hides, because
-- hulls trickle in on different ticks and orbit_epoch spreads them for
-- free. A construction site takes delivery in convoy, so three haulers
-- landed on identical phase AND identical epoch and drew as one sprite
-- — a site that looked like it had a single ship parked at it.
--
-- The code fix (parkPhaseFor, hashed off the ship id) only applies to
-- arrivals from here on. This re-phases the hulls already sitting
-- stacked, so existing games are fixed rather than merely stopping
-- getting worse.
-- ============================================================

UPDATE game_bodies
   SET mu = 100
 WHERE type = 'megastructure'
   AND (mu IS NULL OR mu <= 0);

-- Spread anything currently parked at a site around its ring. SQLite has
-- no hash function, so this derives a phase from the row id's own
-- characters — arbitrary but stable and, crucially, DIFFERENT per ship,
-- which is the only property that matters here.
UPDATE game_ships
   SET orbit_m0 = (
         (unicode(substr(id, -1)) * 37
          + unicode(substr(id, -2, 1)) * 11
          + unicode(substr(id, -3, 1))) % 628
       ) / 100.0
 WHERE status = 'active'
   AND parent_body_id IN (SELECT id FROM game_bodies WHERE type = 'megastructure');
