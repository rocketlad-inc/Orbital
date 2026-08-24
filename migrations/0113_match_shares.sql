-- Shareable WHOLE-MATCH films.
--
-- battle_shares (0100) mints a token per battle and is deliberately
-- narrow: its comment is explicit that a link "must expose the ONE
-- battle it names and nothing else about the match". That is the right
-- rule for a battle recap and the wrong one for a match film, whose
-- entire subject IS the rest of the match -- so this is a separate table
-- rather than a nullable battle_id bolted onto that one. Two token
-- spaces, two paths, and no way for a link of one kind to be read as
-- the other.
--
-- Same shape and same reasoning otherwise: the token is the whole
-- permission and is random rather than derived from the game id, since
-- game ids appear in every screenshot of a lobby. One row per (game,
-- creator) so re-sharing hands back the same link instead of growing a
-- new secret on every click, which would make revocation meaningless.
-- revoked_at_ms turns a link off without destroying the record of it
-- having existed.

CREATE TABLE IF NOT EXISTS match_shares (
  token          TEXT PRIMARY KEY,
  game_id        TEXT NOT NULL,
  created_by     TEXT,
  created_at_ms  INTEGER NOT NULL,
  revoked_at_ms  INTEGER,
  views          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_match_shares_game ON match_shares(game_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_match_shares_game_creator
  ON match_shares(game_id, created_by);
