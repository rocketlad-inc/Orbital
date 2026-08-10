-- 0077_trade_agreements.sql
--
-- STANDING TRADE AGREEMENTS (Lorne): a trade deal that repeats until
-- somebody stops it or something breaks it, instead of moving one
-- shipment and ending.
--
-- Both halves of this already existed and had simply never been joined:
--
--   game_trade_routes (0016)  a freighter auto-pilot that loops forever
--                             — but self-haul only, crediting its own
--                             owner's pool.
--   trade_deliveries  (0041)  a proper cross-faction shipment with
--                             tariffs, piracy and embargo handling —
--                             but strictly one-shot.
--
-- So a standing agreement is the 0016 loop with the 0041 semantics
-- bolted onto its delivery step. The expensive part (leg planning
-- against real torch physics, pickup, delivery, cycling) is reused
-- as-is.
--
-- NO PERIOD COLUMN, deliberately. The cadence of a route is its flight
-- time: a Ceres run repeats slower than a Luna run because it is
-- further, which is the physical answer and needs no tuning knob. It
-- also means distance is a real cost of a trading partner.
--
-- THE AGREEMENT IS THE DEAL; THE ROUTES ARE ITS LEGS. Each giving side
-- gets its own route, and they run UNCOUPLED (Lorne) — neither waits on
-- the other, because a freighter stuck behind the other side's dead
-- freighter is a deadlock nobody can diagnose from the UI. But the deal
-- ENDS as one: if either side cannot pay, both legs stop and the
-- agreement is marked ended, rather than leaving one party shipping into
-- a partner who has stopped shipping back.

CREATE TABLE trade_agreements (
  id                 TEXT PRIMARY KEY,
  game_id            TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  -- The two parties. Named a/b rather than sender/recipient because a
  -- standing agreement is usually goods BOTH ways; who is sending
  -- depends on which leg you are looking at.
  faction_a_id       TEXT NOT NULL,
  faction_b_id       TEXT NOT NULL,
  -- The trade_offers row this was struck from, for provenance and so
  -- the UI can show the original negotiation.
  source_offer_id    TEXT,

  -- THE TERMS, per run, per direction. a_* is what A ships to B; b_* is
  -- what B ships to A. Either side may be all-zero for a one-way lane.
  --
  -- These live here rather than only on the routes because the AGREEMENT
  -- exists before its routes do: game_trade_routes requires an origin and
  -- destination body (NOT NULL since 0016), and neither is known until a
  -- side nominates a freighter and a collector. So the deal is struck
  -- first and each leg is commissioned when its owner assigns a ship —
  -- the same two-step players already know from one-shot deliveries,
  -- except they only do it once instead of every shipment.
  a_metal            INTEGER NOT NULL DEFAULT 0,
  a_fuel             INTEGER NOT NULL DEFAULT 0,
  a_gold             INTEGER NOT NULL DEFAULT 0,
  a_science          INTEGER NOT NULL DEFAULT 0,
  b_metal            INTEGER NOT NULL DEFAULT 0,
  b_fuel             INTEGER NOT NULL DEFAULT 0,
  b_gold             INTEGER NOT NULL DEFAULT 0,
  b_science          INTEGER NOT NULL DEFAULT 0,

  -- Receive-side tariff snapshot per party, taken at accept for the same
  -- reason trade_deliveries.tariff_pct is: a slider passed mid-flight
  -- must not re-price a deal both sides already shook on.
  a_tariff_pct       INTEGER NOT NULL DEFAULT 0,
  b_tariff_pct       INTEGER NOT NULL DEFAULT 0,

  status             TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'ended'
  -- Why it stopped. NULL while active. One of:
  --   'cancelled'   a party called it off
  --   'starved'     a sender could not cover a run (ends BOTH legs)
  --   'war'         the parties exchanged fire
  --   'ship_lost'   a pinned freighter was destroyed
  --   'eliminated'  a party is gone
  ended_reason       TEXT,
  ended_at_tick      INTEGER,
  created_at_tick    INTEGER NOT NULL,
  created_at_ms      INTEGER NOT NULL
);

CREATE INDEX idx_trade_agreements_game
  ON trade_agreements(game_id, status);
-- Both directions, so "does this pair have a standing deal" is one
-- indexed lookup from either side.
CREATE INDEX idx_trade_agreements_a ON trade_agreements(game_id, faction_a_id, status);
CREATE INDEX idx_trade_agreements_b ON trade_agreements(game_id, faction_b_id, status);

-- ---------------------------------------------------------------
-- game_trade_routes gains a counterparty.
--
-- counterparty_faction_id IS NULL keeps the original self-haul
-- behaviour byte for byte — every existing route in every live game
-- reads NULL and is unaffected. The tick only takes the new branch when
-- a counterparty is set.
-- ---------------------------------------------------------------

ALTER TABLE game_trade_routes ADD COLUMN counterparty_faction_id TEXT;
ALTER TABLE game_trade_routes ADD COLUMN agreement_id TEXT;

-- Snapshotted at accept, exactly as trade_deliveries.tariff_pct is, so a
-- senate tariff slider passed mid-flight cannot retroactively re-price a
-- deal both sides already agreed to. Re-read per RUN rather than per
-- agreement would have been the other choice; snapshot is consistent
-- with how one-shot deliveries already behave.
ALTER TABLE game_trade_routes ADD COLUMN tariff_pct INTEGER NOT NULL DEFAULT 0;

-- What this leg ships per run. Self-haul routes ignore these and keep
-- sweeping settlement stockpiles; a cross-faction leg moves exactly the
-- agreed amount out of the sender's POOL, which is where a one-shot
-- delivery draws from too.
ALTER TABLE game_trade_routes ADD COLUMN per_run_metal   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE game_trade_routes ADD COLUMN per_run_fuel    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE game_trade_routes ADD COLUMN per_run_gold    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE game_trade_routes ADD COLUMN per_run_science INTEGER NOT NULL DEFAULT 0;

-- Completed round trips. Drives the per-loop log line and gives the
-- Herald something to say about a lane that has been running for weeks.
ALTER TABLE game_trade_routes ADD COLUMN loops_completed INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_trade_routes_agreement ON game_trade_routes(agreement_id);

-- ---------------------------------------------------------------
-- trade_offers gains a recurring flag.
--
-- An offer marked recurring creates an agreement on accept instead of
-- one-shot deliveries. The resource columns already on the offer become
-- the PER-RUN amounts rather than a single shipment — same numbers, new
-- meaning, which is why the flag lives on the offer and is shown
-- prominently in the composer.
-- ---------------------------------------------------------------

ALTER TABLE trade_offers ADD COLUMN recurring INTEGER NOT NULL DEFAULT 0;
