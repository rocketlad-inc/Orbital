-- Hulls and worlds on the open market.
--
-- A ship or world sale needed a named buyer, so selling one meant
-- already knowing who wanted it. An OPEN LISTING is a sale addressed to
-- nobody: every faction sees it on the market board and the first to
-- claim it becomes the buyer, after which it is an ordinary sale (the
-- buyer hauls the payment to where the asset stands).
--
-- buyer_faction_id is NOT NULL with a foreign key, and SQLite cannot
-- relax that without rebuilding the table, so an unclaimed listing
-- carries its SELLER in that column and this flag says what it really is:
--   0  a private sale to a named buyer (every existing row)
--   1  open, unclaimed — buyer_faction_id is a placeholder
--   2  began as an open listing, since claimed — buyer_faction_id is real
ALTER TABLE trade_asset_deals ADD COLUMN open_listing INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_asset_deals_open ON trade_asset_deals (game_id, status, open_listing);
