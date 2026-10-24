-- ============================================================
-- 0185 — game_sagas: the script of each finished match's film.
--
-- The Saga Engine (worker/saga/) reads a finished match's PUBLIC record and
-- writes the script its film plays: the crawl, the cast and their roles, the
-- stories, the story scenes and their words, the veteran captains, the
-- transmissions, the roll call. It is written once, when the match ends (or
-- the first time its film is opened), and kept with the game's data so a
-- shared film never changes under the person watching it (Lorne,
-- 2026-10-24: "Store it in the gamedata").
--
-- game_id         the game (no foreign key: imported and archived games keep theirs)
-- engine_version  SAGA_ENGINE_VERSION that wrote it; an older one is rebuilt
-- ordinal         the film counter: how many films the engine wrote before this
--                 one. It moves every phrase bank's entry point, so two matches
--                 ending back to back never open the same way.
-- script          the script, JSON
-- built_at_ms     when it was written
--
-- Schema only: safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS game_sagas (
  game_id        TEXT PRIMARY KEY,
  engine_version INTEGER NOT NULL,
  ordinal        INTEGER NOT NULL DEFAULT 0,
  script         TEXT NOT NULL,
  built_at_ms    INTEGER NOT NULL
);
