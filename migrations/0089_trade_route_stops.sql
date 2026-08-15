-- 0089_trade_route_stops.sql
--
-- TRADE V2 (DESIGN-trade-v2.md): a route stops being "a freighter with a
-- destination" and becomes a standing object with a STOP LIST and a CREW.
--
-- This is the SHADOW deploy: schema + backfill only. Nothing reads these
-- tables until the cutover lands, so this migration is reversible in the
-- only sense that matters — no behaviour changes while it soaks.
--
-- Two new nouns:
--
--   game_trade_route_stops   the ordered itinerary. Backfilled so every
--                            active route is a two-stop route (origin =
--                            stop 0 pickup, dest = stop 1 dropoff) and the
--                            cutover's acceptance test is byte-equivalence
--                            with today's ping-pong.
--
--   game_trade_route_ships   the crew. role='carrier' runs the route,
--                            role='guard' paces a named carrier
--                            (follow_ship_id) and holds defensive stance
--                            at every stop. Carrier rows own their cargo
--                            and their own cursor (next_stop_seq) so two
--                            carriers can walk the same loop out of phase.
--
-- Cargo authority after cutover, by route kind:
--   logistics self-haul / consolidated  -> the CARRIER ROW's cargo columns
--     (game_trade_routes.cargo_* kept as a display mirror of the PRIMARY
--     carrier for stale clients and legacy readers).
--   terraform / dyson / agreement legs  -> game_trade_routes.cargo_*
--     exactly as today; their branches are untouched and single-carrier
--     by rule, and their crew rows carry zeros.
-- Piracy loots whichever store is authoritative for the kind — never both,
-- or a primary carrier's death would credit the killer twice.

CREATE TABLE game_trade_route_stops (
  id        TEXT PRIMARY KEY,
  game_id   TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  route_id  TEXT NOT NULL,
  sequence  INTEGER NOT NULL,          -- visiting order, 0-based
  body_id   TEXT NOT NULL,
  action    TEXT NOT NULL DEFAULT 'pickup',   -- 'pickup' | 'dropoff'
  -- Pickup filters ("metal only"). Dropoff ignores them and drops
  -- everything aboard — one lever, not a matrix.
  take_metal   INTEGER NOT NULL DEFAULT 1,
  take_gold    INTEGER NOT NULL DEFAULT 1,
  take_science INTEGER NOT NULL DEFAULT 1,
  UNIQUE (route_id, sequence)
);
CREATE INDEX idx_route_stops_route ON game_trade_route_stops(route_id, sequence);
-- The Trade tab's question is "which routes stop HERE" — this is that index.
CREATE INDEX idx_route_stops_body ON game_trade_route_stops(game_id, body_id);

CREATE TABLE game_trade_route_ships (
  id             TEXT PRIMARY KEY,
  game_id        TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  route_id       TEXT NOT NULL,
  ship_id        TEXT NOT NULL,
  role           TEXT NOT NULL,        -- 'carrier' | 'guard'
  -- Guards pace ONE NAMED carrier (Lorne: diagnosable beats clever). When
  -- that carrier dies the tick re-attaches the guard to a surviving
  -- carrier on the same route; if none survive, the guard holds position.
  follow_ship_id TEXT,
  next_stop_seq  INTEGER NOT NULL DEFAULT 0,
  cargo_fuel     REAL NOT NULL DEFAULT 0,
  cargo_metal    REAL NOT NULL DEFAULT 0,
  cargo_gold     REAL NOT NULL DEFAULT 0,
  cargo_science  REAL NOT NULL DEFAULT 0,
  added_at_tick  INTEGER NOT NULL DEFAULT 0
);
-- One job per hull, ANY role — a freighter can't run two routes, and a
-- warship can't guard two. Every cancel path must delete crew rows or the
-- ship is stuck "employed" by a dead route forever.
CREATE UNIQUE INDEX idx_route_ships_ship ON game_trade_route_ships(ship_id);
CREATE INDEX idx_route_ships_route ON game_trade_route_ships(route_id);

-- Route-level additions.
ALTER TABLE game_trade_routes ADD COLUMN name TEXT;
-- 'forever' (default) | 'count' — 'count' decrements loops_remaining on
-- each wrap past the last stop and retires the route at zero. "Run once,
-- then park" is loop_mode='count', loops_remaining=1.
ALTER TABLE game_trade_routes ADD COLUMN loop_mode TEXT NOT NULL DEFAULT 'forever';
ALTER TABLE game_trade_routes ADD COLUMN loops_remaining INTEGER;
-- Stall clock (DESIGN-trade-v2 §6): losing the last carrier STALLS the
-- route instead of cancelling it. 30 ticks to re-crew, then auto-cancel.
-- NULL everywhere at migration time BY CONSTRUCTION: today a route dies
-- with its ship, so no carrier-less route exists to backfill.
ALTER TABLE game_trade_routes ADD COLUMN stalled_since_tick INTEGER;
-- One freighter serving BOTH directions of a standing agreement (§8 —
-- "the return leg is sold, not deleted"). Terms are read from the
-- agreement row per direction; the tariff snapshot below applies to both.
ALTER TABLE game_trade_routes ADD COLUMN consolidated INTEGER NOT NULL DEFAULT 0;

-- Consolidation is an OFFER through the same accept flow the agreement
-- itself used — never a migration. Two routes owned by two players merge
-- only when the second player says yes.
ALTER TABLE trade_agreements ADD COLUMN consolidate_offer_ship_id TEXT;
ALTER TABLE trade_agreements ADD COLUMN consolidate_offered_by TEXT;
ALTER TABLE trade_agreements ADD COLUMN consolidate_offered_at_tick INTEGER;

-- ---------------------------------------------------------------
-- Backfill: ACTIVE routes only. Cancelled routes are never read for
-- stops or crew, and crew rows for a ship's dead routes would collide
-- on the one-job-per-hull index the moment it took a new job.
-- ---------------------------------------------------------------
-- OR IGNORE on every backfill: handleInit stamps a migration only when
-- ALL of its statements succeed, so one failure partway leaves the DDL
-- applied, the migration unstamped, and each retry colliding with the
-- rows the first attempt already wrote — which is exactly how this
-- migration wedged on production, taking 0090 and 0091 down with it.
-- Idempotent backfills make the retry finish the job instead.
INSERT OR IGNORE INTO game_trade_route_stops (id, game_id, route_id, sequence, body_id, action)
  SELECT r.id || ':s0', r.game_id, r.id, 0, r.origin_body_id, 'pickup'
    FROM game_trade_routes r WHERE r.cancelled_at_tick IS NULL;
INSERT OR IGNORE INTO game_trade_route_stops (id, game_id, route_id, sequence, body_id, action)
  SELECT r.id || ':s1', r.game_id, r.id, 1, r.dest_body_id, 'dropoff'
    FROM game_trade_routes r WHERE r.cancelled_at_tick IS NULL;

-- Crew backfill. The delicate mapping (DESIGN-trade-v2 §11): status is a
-- direction flag, the cursor is a destination index. 'outbound' = loaded,
-- heading for the dest = next stop 1. 'returning'/'paused' = heading for
-- (or parked at) the origin = next stop 0. A ship already IN FLIGHT has a
-- live node with a real target; the cutover loop skips in-flight ships
-- exactly as today, so that node is adopted, not re-planned — the cursor
-- only says what happens at the NEXT arrival, which is the same thing the
-- status flag said.
INSERT OR IGNORE INTO game_trade_route_ships
  (id, game_id, route_id, ship_id, role, next_stop_seq,
   cargo_fuel, cargo_metal, cargo_gold, cargo_science, added_at_tick)
  SELECT r.id || ':c0', r.game_id, r.id, r.ship_id, 'carrier',
         CASE WHEN r.status = 'outbound' THEN 1 ELSE 0 END,
         -- Cargo copies over ONLY where the crew row becomes the
         -- authority (logistics self-haul). Terraform/dyson/agreement
         -- legs keep authority in the route columns; a stale copy here
         -- would be a second source of truth waiting to be double-looted.
         CASE WHEN r.kind = 'logistics' AND r.counterparty_faction_id IS NULL THEN r.cargo_fuel    ELSE 0 END,
         CASE WHEN r.kind = 'logistics' AND r.counterparty_faction_id IS NULL THEN r.cargo_metal   ELSE 0 END,
         CASE WHEN r.kind = 'logistics' AND r.counterparty_faction_id IS NULL THEN r.cargo_gold    ELSE 0 END,
         CASE WHEN r.kind = 'logistics' AND r.counterparty_faction_id IS NULL THEN r.cargo_science ELSE 0 END,
         r.created_at_tick
    FROM game_trade_routes r WHERE r.cancelled_at_tick IS NULL;
