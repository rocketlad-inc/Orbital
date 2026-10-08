-- ============================================================
-- 0162 — the Leviathan: the second sun gate arrives on a monster
--
-- Lorne, 2026-10-07: "what if the next gate IS a Kaiju squid?" The
-- second gate no longer comes out of the Sun. A squid the size of a
-- moon launches from the far system that is not yet connected, burns
-- for Sol at 2g, drops the gate where it stops, then hunts: settled
-- moons and small worlds first, outermost in, never a homeworld, two
-- strikes for a living world like a Mega Destroyer. It leaves after it
-- has eaten its fill. Kill it and the carcass stays as salvage
-- (worker/kaiju.js).
--
-- game_kaiju — one row per game that has had one. The beast itself is
--   an ordinary hull (game_ships, class 'kaiju') owned by an ordinary
--   faction row whose status is 'monster': every "active empires" query
--   already leaves it out, and wars.js makes it at war with everyone.
--     phase: inbound -> hunting -> leaving -> gone, or -> dead.
--     appetite / eaten: worlds it will take before it leaves, and has.
--     eaten_json: the names, in order, for the Herald and the log.
--     hp_max: rolled at launch from the game's fleets (scaled, capped).
-- ============================================================

CREATE TABLE IF NOT EXISTS game_kaiju (
  game_id           TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  ship_id           TEXT NOT NULL,
  faction_id        TEXT NOT NULL,
  sys_key           TEXT NOT NULL,
  launched_at_tick  INTEGER NOT NULL,
  arrive_tick       INTEGER NOT NULL,
  hp_max            INTEGER NOT NULL,
  appetite          INTEGER NOT NULL,
  eaten             INTEGER NOT NULL DEFAULT 0,
  eaten_json        TEXT NOT NULL DEFAULT '[]',
  phase             TEXT NOT NULL DEFAULT 'inbound',
  target_body_id    TEXT,
  died_at_tick      INTEGER,
  died_at_body_id   TEXT,
  carcass_body_id   TEXT,
  gone_at_tick      INTEGER
);
