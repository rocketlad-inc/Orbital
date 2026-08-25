-- ============================================================
-- Selling ships and worlds for freight.
--
-- Trade agreements move RESOURCES on a standing lane. This is the other
-- kind of deal: a one-off sale where the thing changing hands is a hull
-- or a settled world, and the payment is hauled in by freighter.
--
-- WHY AN ESCROW METER RATHER THAN A STANDING LANE. The trade tick has
-- several delivery paths — consolidated lanes, walkers, legacy legs —
-- and crediting a sale from inside all of them means a tally that is
-- correct in three places and silently wrong in the fourth. A deal
-- carries its own meter instead, filled the way a megastructure site is
-- filled: park a loaded hull on the delivery point and unload into it.
-- One path, fully attributable, and the freight is unmistakably tied to
-- the deal it is paying for.
--
-- THE DELIVERY POINT IS THE ASSET ITSELF. You haul the payment to the
-- world you are buying, or to the hull you are buying, and take
-- possession on the spot. That is the thematically obvious place and it
-- removes an entire class of question about where a payment goes.
--
-- Nothing is escrowed on the SELLER's side, deliberately. A seller who
-- scraps the hull or loses the world mid-deal fails the handover check
-- and the deal ends unfulfilled with the buyer's freight already spent —
-- which is a real risk a player takes on a stranger, and exactly the
-- kind of thing diplomacy should have teeth about.
-- ============================================================

CREATE TABLE trade_asset_deals (
  id                TEXT PRIMARY KEY,
  game_id           TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,

  seller_faction_id TEXT NOT NULL REFERENCES game_factions(id) ON DELETE CASCADE,
  buyer_faction_id  TEXT NOT NULL REFERENCES game_factions(id) ON DELETE CASCADE,

  -- 'ship' | 'settlement'. A "planet" is sold by transferring the
  -- settlement standing on it: body ownership in this game is derived
  -- from settlements, so the settlement IS the deed.
  asset_kind        TEXT NOT NULL,
  asset_id          TEXT NOT NULL,
  -- Where the payment is hauled, and where possession changes hands.
  -- Snapshotted at proposal so a ship that wanders does not move the
  -- delivery point out from under a freighter already in flight.
  delivery_body_id  TEXT NOT NULL,

  price_metal       INTEGER NOT NULL DEFAULT 0,
  price_credits     INTEGER NOT NULL DEFAULT 0,
  paid_metal        REAL NOT NULL DEFAULT 0,
  paid_credits      REAL NOT NULL DEFAULT 0,

  -- 'offered'   proposed, awaiting the buyer
  -- 'active'    accepted; the meter is open
  -- 'fulfilled' paid in full and handed over
  -- 'declined' | 'cancelled' | 'void'
  status            TEXT NOT NULL DEFAULT 'offered',
  -- Why it ended badly. 'asset_gone' covers scrapped, destroyed, or
  -- already sold to somebody else.
  ended_reason      TEXT,
  created_at_tick   INTEGER NOT NULL,
  ended_at_tick     INTEGER
);

CREATE INDEX idx_asset_deals_game   ON trade_asset_deals(game_id, status);
CREATE INDEX idx_asset_deals_buyer  ON trade_asset_deals(buyer_faction_id, status);
CREATE INDEX idx_asset_deals_seller ON trade_asset_deals(seller_faction_id, status);
-- One live deal per asset: without this the same hull can be sold twice
-- and the second buyer pays for something already handed over.
CREATE UNIQUE INDEX idx_asset_deals_live ON trade_asset_deals(asset_id)
  WHERE status IN ('offered', 'active');
