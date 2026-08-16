-- METEOROIDS — the minable class.
--
-- Deliberately NOT the existing `asteroid` type. Asteroids are
-- hand-authored, settleable real estate you claim and keep, carrying a
-- per-tick yield. A meteoroid is the opposite: consumable, exhausted,
-- and removed. Keeping them one type would mean every settle/claim/
-- build path needs a "but not this kind" branch, and players would try
-- to found cities on rocks that are about to disappear.
--
-- Two pieces of state, and they live in different places for a reason.

-- 1. WHAT IS LEFT IN THE ROCK. A property of the world, same for
--    everyone. Nullable so every existing body is untouched: only rows
--    with a non-null remaining are minable, which also means "is this a
--    meteoroid" has one answer and not two that can disagree.
ALTER TABLE game_bodies ADD COLUMN mineral_kind TEXT;          -- 'metal' | 'gold'
ALTER TABLE game_bodies ADD COLUMN mineral_remaining REAL;     -- units left in the rock
ALTER TABLE game_bodies ADD COLUMN mineral_initial REAL;       -- what it held at spawn
ALTER TABLE game_bodies ADD COLUMN exhausted_at_tick INTEGER;  -- set when it runs dry

-- 2. WHO KNOWS IT IS THERE. NOT a boolean on the body: discovery is
--    PER FACTION. Each empire has its own idea of what exists, so a
--    rock found by one player must stay invisible to the others until
--    they find it themselves — and a flag on the body cannot express
--    that. This is also the seam where a defence pact could share
--    survey data later, since intel sharing already works that way.
CREATE TABLE IF NOT EXISTS game_body_discoveries (
  game_id           TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  body_id           TEXT NOT NULL REFERENCES game_bodies(id) ON DELETE CASCADE,
  faction_id        TEXT NOT NULL REFERENCES game_factions(id) ON DELETE CASCADE,
  discovered_at_tick INTEGER NOT NULL,
  -- How they found it, for the Herald and for tuning which method
  -- actually gets used: 'flyby' (a hull passed close) or 'survey' (a
  -- Telescope found it).
  method            TEXT NOT NULL DEFAULT 'flyby',
  PRIMARY KEY (game_id, body_id, faction_id)
);

-- The hot query is "everything MY faction can see in this game", run on
-- every /state. The primary key leads with game_id + body_id, which
-- cannot serve it.
CREATE INDEX IF NOT EXISTS idx_discoveries_faction
  ON game_body_discoveries (game_id, faction_id);

-- 3. THE DISCOVERER MAY RENAME IT. Kept on the body rather than in the
--    discoveries table: a rock has ONE name that everyone who can see
--    it reads, so the first finder names it for the whole system. That
--    is what makes the map a record of who found what.
ALTER TABLE game_bodies ADD COLUMN named_by_faction_id TEXT;
