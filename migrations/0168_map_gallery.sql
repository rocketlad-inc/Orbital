-- The Map Maker, part two (Lorne, 2026-10-15): a public gallery of
-- player-built systems, remixes, and a hand-placed discovery's own words.
--
-- published / published_ms: the owner put the map in the public gallery.
-- remix_count: how many OTHER players copied it from there (the owner's
-- own copies never count).
ALTER TABLE custom_maps ADD COLUMN published INTEGER NOT NULL DEFAULT 0;
ALTER TABLE custom_maps ADD COLUMN published_ms INTEGER;
ALTER TABLE custom_maps ADD COLUMN remix_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_custom_maps_gallery_popular ON custom_maps(published, hosted_count);
CREATE INDEX IF NOT EXISTS idx_custom_maps_gallery_new ON custom_maps(published, published_ms);

-- A hand-placed discovery's custom name and message, written by the map's
-- maker. Stored beside secret_kind and, like it, never sent to a player
-- until the discovery is revealed (worker/state.js). NULL = the kind's
-- own name and message.
ALTER TABLE game_bodies ADD COLUMN secret_name TEXT;
ALTER TABLE game_bodies ADD COLUMN secret_text TEXT;
