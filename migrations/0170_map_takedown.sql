-- Gallery moderation (Map Maker launch, 2026-10-16): an admin can take a
-- published map out of the gallery, and the owner cannot republish it.
-- The map itself is untouched: it stays in its owner's list and can
-- still be hosted privately.
ALTER TABLE custom_maps ADD COLUMN taken_down_ms INTEGER;
ALTER TABLE custom_maps ADD COLUMN taken_down_by TEXT;
