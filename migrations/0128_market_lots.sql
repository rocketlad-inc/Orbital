-- Market, second pass: lots, a real tape, chosen lifetimes.
--
-- PARTIAL FILLS. "5,000 metal at 0.6" used to need one buyer who wanted
-- exactly 5,000. A DIVISIBLE post (one resource each way, one-time) is
-- sold by the unit: takers buy any amount and pay pro rata, rounded up
-- in the poster's favour. filled_units counts units of the OFFER
-- resource already sold or reserved by a take in flight. A post that is
-- not divisible is one lot: it has exactly 1 unit.
--
-- THE TAPE. With many fills per post, "who took it" no longer fits on
-- the post row. market_fills holds one row per deal struck; the public
-- tape, the going-rate line and the dead-claim repair all read it.
--
-- LIFETIMES. ttl_ticks is the lifetime the poster chose, kept so RENEW
-- can grant the same again. lapse_notified makes the "your post
-- expired" message a once-only.

ALTER TABLE market_posts ADD COLUMN divisible INTEGER NOT NULL DEFAULT 0;
ALTER TABLE market_posts ADD COLUMN filled_units INTEGER NOT NULL DEFAULT 0;
ALTER TABLE market_posts ADD COLUMN ttl_ticks INTEGER NOT NULL DEFAULT 72;
ALTER TABLE market_posts ADD COLUMN lapse_notified INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS market_fills (
  id                 TEXT PRIMARY KEY,
  game_id            TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  post_id            TEXT NOT NULL,
  poster_faction_id  TEXT NOT NULL,
  taker_faction_id   TEXT NOT NULL,
  units              INTEGER NOT NULL DEFAULT 1,
  offer_metal        INTEGER NOT NULL DEFAULT 0,
  offer_gold         INTEGER NOT NULL DEFAULT 0,
  offer_science      INTEGER NOT NULL DEFAULT 0,
  request_metal      INTEGER NOT NULL DEFAULT 0,
  request_gold       INTEGER NOT NULL DEFAULT 0,
  request_science    INTEGER NOT NULL DEFAULT 0,
  recurring          INTEGER NOT NULL DEFAULT 0,
  trade_offer_id     TEXT,
  at_tick            INTEGER NOT NULL,
  at_ms              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_market_fills_game_time ON market_fills (game_id, at_ms);
CREATE INDEX IF NOT EXISTS idx_market_fills_post ON market_fills (post_id);

-- Posts filled before this migration become one-lot fills, so the tape
-- and the going rate do not start empty.
INSERT INTO market_fills
  (id, game_id, post_id, poster_faction_id, taker_faction_id, units,
   offer_metal, offer_gold, offer_science,
   request_metal, request_gold, request_science,
   recurring, trade_offer_id, at_tick, at_ms)
SELECT 'mf_' || id, game_id, id, poster_faction_id, taken_by_faction_id, 1,
       offer_metal, offer_gold, offer_science,
       request_metal, request_gold, request_science,
       recurring, trade_offer_id, COALESCE(taken_at_tick, 0), COALESCE(taken_at_ms, 0)
  FROM market_posts
 WHERE status = 'filled' AND taken_by_faction_id IS NOT NULL;

UPDATE market_posts SET filled_units = 1 WHERE status = 'filled';
-- The short-lived 'taking' claim is replaced by unit reservations.
UPDATE market_posts SET status = 'open' WHERE status = 'taking';
