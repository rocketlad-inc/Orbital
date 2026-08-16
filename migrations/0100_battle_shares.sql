-- Shareable battle recaps.
--
-- A recap is the most watchable thing the game produces and it has been
-- locked behind an admin session, which means the only way to show
-- someone a fight is to describe it. This mints an opaque token per
-- battle that serves the recap to anyone holding the link.
--
-- The token is the whole permission. It is random rather than derived
-- from the battle id, because battle ids are `b_<tick>_<bodyId>` and are
-- therefore guessable from any screenshot -- a shared link must expose
-- the ONE battle it names and nothing else about the match.
--
-- One row per (battle, creator) so re-sharing hands back the same link
-- rather than growing a new secret every click, which would make
-- revocation meaningless. `revoked_at_ms` turns a link off without
-- destroying the record of it having existed.

CREATE TABLE IF NOT EXISTS battle_shares (
  token          TEXT PRIMARY KEY,
  battle_id      TEXT NOT NULL,
  game_id        TEXT NOT NULL,
  created_by     TEXT,
  created_at_ms  INTEGER NOT NULL,
  revoked_at_ms  INTEGER,
  views          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_shares_battle ON battle_shares(battle_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_battle_creator
  ON battle_shares(battle_id, created_by);
