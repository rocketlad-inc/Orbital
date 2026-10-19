-- ============================================================
-- 0173 — a found ship is an offer the finder can refuse
-- (worker/discoveryOffers.js).
--
-- Lorne, 2026-10-18: "We need to add an option to refuse a structure/craft
-- a player discovers. Sometimes they can't afford it." A derelict
-- destroyer or an ancient capital ship now waits here for its finder's
-- answer instead of being minted on the spot.
--
-- status: pending  -> waiting for the finder (expires_tick: claimed for
--                     them if they never answer, as finds always were)
--         claimed  -> minted; the body is revealed
--         refused  -> nothing minted; the find waits for another empire,
--                     and this one's ships never trigger it again
--         lapsed   -> the finder's empire was gone when it expired
-- One row per (body, faction): an empire is asked about a world once.
-- ============================================================

CREATE TABLE IF NOT EXISTS discovery_offers (
  game_id       TEXT NOT NULL,
  body_id       TEXT NOT NULL,
  faction_id    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  capital_kind  TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  offered_tick  INTEGER NOT NULL,
  expires_tick  INTEGER NOT NULL,
  resolved_tick INTEGER,
  PRIMARY KEY (body_id, faction_id)
);

CREATE INDEX IF NOT EXISTS idx_discovery_offers_game_status
  ON discovery_offers (game_id, status, expires_tick);
