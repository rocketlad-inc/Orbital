-- Progress cursor for the match-snapshot backfill sweep.
--
-- A quiet synthetic tick writes no snapshot row, so "MAX(tick) over
-- synthetic rows" cannot tell a finished game from one whose tail was
-- simply quiet -- the sweep would re-walk that tail every minute
-- forever. An explicit cursor makes completion a fact rather than an
-- inference.
CREATE TABLE match_backfill_progress (
  game_id   TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  next_from INTEGER NOT NULL,
  done      INTEGER NOT NULL DEFAULT 0
);
