-- 0137_situation_badges.sql
--
-- THE SITUATION LOG'S BADGE, AS THE GAME ITSELF COUNTED IT.
--
-- The dock's situation badge is derived in the client, from game state,
-- by some forty rules in useSituationItems -- and it honours what the
-- player dismissed, which lives in that browser. The server cannot
-- recompute that number, and a watch complication that showed a
-- different one would be a second badge that disagrees with the first.
--
-- So the open game reports its badge here whenever it changes (and every
-- ten minutes while it stays open), and the watch shows it with its age.
-- One row per faction per game: the latest count is the only state
-- there is. Lorne chose this over a server-side approximation: an exact
-- number that can be hours old beats a fresh one that is not the badge.

CREATE TABLE IF NOT EXISTS situation_badges (
  game_id     TEXT NOT NULL,
  faction_id  TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  -- 1 when something is being shot at right now (the badge's red flag).
  now         INTEGER NOT NULL DEFAULT 0,
  updated_ms  INTEGER NOT NULL,
  PRIMARY KEY (game_id, faction_id)
);
