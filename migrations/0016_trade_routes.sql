-- Trade routes (MP).
--
-- A trade route is a recurring freighter ferry between an origin
-- settlement and a destination collector. The Room DO alarm
-- auto-pilots the freighter: pick up at origin → fly to dest → drop
-- off → fly back → repeat until cancelled. If the freighter is
-- destroyed mid-route, the cargo is captured by the killer's pool
-- (piracy, handled in the combat block of resolveTick).
--
-- Columns mirror the client TradeRoute type. Server uses metal/gold
-- column names; the client maps to ore/credits at the deserialization
-- boundary (same convention as game_settlements.stockpile_*).
--
-- One active route per ship. If a player creates a second route for
-- the same freighter we replace the existing one (UI guard already
-- prevents this; the server still validates).

CREATE TABLE game_trade_routes (
  id                TEXT PRIMARY KEY,
  game_id           TEXT NOT NULL,
  owner_faction_id  TEXT NOT NULL,
  ship_id           TEXT NOT NULL,
  origin_body_id    TEXT NOT NULL,
  dest_body_id      TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'returning',
                    -- 'outbound'  = heading toward dest (cargo full)
                    -- 'returning' = heading toward origin (cargo empty)
                    -- 'paused'    = player paused; auto-pilot skips
  cargo_fuel        REAL NOT NULL DEFAULT 0,
  cargo_metal       REAL NOT NULL DEFAULT 0,
  cargo_gold        REAL NOT NULL DEFAULT 0,
  cargo_science     REAL NOT NULL DEFAULT 0,
  created_at_tick   INTEGER NOT NULL,
  cancelled_at_tick INTEGER
);

CREATE INDEX idx_trade_routes_game ON game_trade_routes(game_id, cancelled_at_tick);
CREATE UNIQUE INDEX idx_trade_routes_ship_active
  ON game_trade_routes(ship_id) WHERE cancelled_at_tick IS NULL;
