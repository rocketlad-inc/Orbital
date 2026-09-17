-- The open market.
--
-- Every trade in the game so far has been a private letter: you pick a
-- faction, you name terms, they answer. That works when you already know
-- who has spare metal. It does not work for "I have 500 metal, who wants
-- it?" — the only way to ask that was to type it into comms and hope.
-- (Sean, #general: a marketplace within trades.)
--
-- A market post is an offer with NO NAMED RESPONDER. Everyone in the game
-- can see every open post — including what their enemies are selling —
-- and anyone but the poster can take one. Taking it mints an ordinary
-- trade_offers row (poster = proposer, taker = responder) and runs it
-- through the normal accept path, so deliveries, standing agreements,
-- tariffs and pinned freighters all behave exactly as a private deal.
-- This table only holds the advert; the deal lives where deals live.
--
-- status: open -> taking -> filled      (taken)
--         open -> withdrawn             (poster pulled it)
-- 'taking' is a short claim so two takers cannot both win the race.
-- Expiry is lazy: a post past expires_at_tick is simply not listed and
-- cannot be taken; no tick pass sweeps it.

CREATE TABLE IF NOT EXISTS market_posts (
  id                  TEXT PRIMARY KEY,
  game_id             TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  poster_faction_id   TEXT NOT NULL REFERENCES game_factions(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'open',
  offer_metal         INTEGER NOT NULL DEFAULT 0,
  offer_gold          INTEGER NOT NULL DEFAULT 0,
  offer_science       INTEGER NOT NULL DEFAULT 0,
  request_metal       INTEGER NOT NULL DEFAULT 0,
  request_gold        INTEGER NOT NULL DEFAULT 0,
  request_science     INTEGER NOT NULL DEFAULT 0,
  -- Standing route: the amounts are PER-RUN rates (same meaning as
  -- trade_offers.recurring). offered_ship_id is the poster's pinned
  -- freighter; it is re-checked at take time and the deal falls back to
  -- commission-a-leg-each if the hull has since found other work.
  recurring           INTEGER NOT NULL DEFAULT 0,
  offered_ship_id     TEXT,
  note                TEXT,
  created_at_tick     INTEGER NOT NULL,
  created_at_ms       INTEGER NOT NULL,
  expires_at_tick     INTEGER NOT NULL,
  taking_at_ms        INTEGER,
  taken_by_faction_id TEXT REFERENCES game_factions(id),
  taken_at_tick       INTEGER,
  taken_at_ms         INTEGER,
  trade_offer_id      TEXT
);
CREATE INDEX IF NOT EXISTS idx_market_posts_game_status
  ON market_posts (game_id, status, expires_at_tick);

-- Which market post a private offer came from: set on the offer minted
-- by a take, and on a private counter sent in answer to a post.
ALTER TABLE trade_offers ADD COLUMN market_post_id TEXT;
