-- ============================================================================
-- WAR IS DECLARED, NOT ASSUMED.
--
-- Until now this game had no war state at all. room.js said so in as many
-- words: "'Players go to war' has no formal declaration in this game -- no
-- war flag, only pacts and their absence." Hostility was the ABSENCE of an
-- agreement, so every faction shot every other faction from tick one, and
-- the only way out was to negotiate a non-aggression pact as a term inside
-- a trade deal -- which needs a willing counterparty and a completed deal
-- just to not be fired on. The commonest complaint about the game was that
-- everyone starts at war, and they were right: they did.
--
-- A row here is the ONE source of truth for "will these two shoot". Peace
-- is the absence of a row. Pacts keep their old meaning -- a promise not
-- to declare -- and declaring on a pact partner breaks the pact and says
-- so, which is what broken_at_tick and breaker_faction_id were always for.
--
-- PAIR ORDER IS NORMALISED (faction_a < faction_b) by the writer, so the
-- partial unique index below actually means "one open war per pair".
-- A war has no owner: declared_by records who started it, for the Herald
-- and for blame, but either side may end it.
-- ============================================================================

CREATE TABLE game_wars (
  id                TEXT PRIMARY KEY,
  game_id           TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  faction_a         TEXT NOT NULL REFERENCES game_factions(id) ON DELETE CASCADE,
  faction_b         TEXT NOT NULL REFERENCES game_factions(id) ON DELETE CASCADE,
  declared_by       TEXT NOT NULL REFERENCES game_factions(id),
  declared_at_tick  INTEGER NOT NULL,
  ended_at_tick     INTEGER,
  ended_by          TEXT REFERENCES game_factions(id),
  -- 'declared' | 'seeded' (pre-existing fighting at rollout) | 'pact_broken'
  origin            TEXT NOT NULL DEFAULT 'declared'
);

CREATE INDEX idx_wars_game ON game_wars(game_id, ended_at_tick);

-- One OPEN war per pair. Ended wars accumulate as history, which is why
-- this is partial rather than a plain UNIQUE on the pair.
CREATE UNIQUE INDEX idx_wars_one_open
  ON game_wars(game_id, faction_a, faction_b)
  WHERE ended_at_tick IS NULL;
