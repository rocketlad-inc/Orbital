-- 0041_trade_deliveries.sql
--
-- Physical trade delivery. Accepting a trade no longer teleports
-- resources between faction pools — it creates one delivery row per
-- giving side, and the goods only move when a freighter physically
-- hauls them from one of the sender's collectors to one of the
-- recipient's collectors.
--
-- Lifecycle (driven by the room tick, pass 2d):
--   unassigned  no ship yet. The obligation exists; the sender is
--               prompted in the Trades panel to assign a freighter.
--   to_pickup   ship assigned, en route to (or sitting at) pickup_body.
--               Cargo NOT yet aboard — pool not yet debited.
--   outbound    loaded. Sender's pool was debited in the same tick the
--               ship sat at its collector; goods now ride the hull.
--   delivered   arrived at dest_body; recipient's pool credited (minus
--               the tariff snapshotted at accept).
--   lost        freighter destroyed with cargo aboard — the killer
--               looted the hold (mirrors trade-route piracy). If the
--               ship dies BEFORE loading, the row returns to
--               'unassigned' instead: nothing was aboard, the
--               obligation survives, assign another freighter.
--
-- Cargo amounts live HERE, not on game_ships — same pattern as
-- game_trade_routes.cargo_*: the mission row is the manifest.
--
-- tariff_pct is snapshotted at accept so a senate slider passed while
-- the freighter is mid-burn doesn't retroactively re-price a deal both
-- sides already agreed to.

CREATE TABLE IF NOT EXISTS trade_deliveries (
  id                   TEXT PRIMARY KEY,
  game_id              TEXT NOT NULL,
  trade_id             TEXT NOT NULL,
  sender_faction_id    TEXT NOT NULL,
  recipient_faction_id TEXT NOT NULL,
  ship_id              TEXT,              -- NULL until a freighter is assigned
  status               TEXT NOT NULL DEFAULT 'unassigned',
  pickup_body_id       TEXT,              -- sender collector chosen at assign
  dest_body_id         TEXT,              -- recipient collector chosen at assign
  metal                INTEGER NOT NULL DEFAULT 0,
  fuel                 INTEGER NOT NULL DEFAULT 0,
  gold                 INTEGER NOT NULL DEFAULT 0,
  science              INTEGER NOT NULL DEFAULT 0,
  loaded               INTEGER NOT NULL DEFAULT 0,  -- 1 = cargo aboard, pool debited
  tariff_pct           INTEGER NOT NULL DEFAULT 0,
  created_at_tick      INTEGER NOT NULL DEFAULT 0,
  resolved_at_tick     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_trade_deliveries_game_active
  ON trade_deliveries (game_id) WHERE resolved_at_tick IS NULL;
CREATE INDEX IF NOT EXISTS idx_trade_deliveries_ship
  ON trade_deliveries (ship_id) WHERE ship_id IS NOT NULL;

-- Every capital city gets a collector, in EVERY game (live ones too —
-- physical delivery rolls out everywhere, so every faction needs at
-- least one place to load and one place to receive from day one).
-- Additional collectors stay behind Propulsion 4 exactly as before;
-- this only guarantees the floor.
UPDATE game_settlements
   SET has_collector = 1
 WHERE type = 'city'
   AND has_collector = 0
   AND EXISTS (
     SELECT 1 FROM game_factions f
      WHERE f.game_id = game_settlements.game_id
        AND f.id = game_settlements.owner_faction_id
        AND f.capital_body_id = game_settlements.body_id
   );
