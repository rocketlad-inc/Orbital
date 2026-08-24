-- ============================================================
-- Megastructures get hull points.
--
-- Taking a structure used to be a presence check: park an armed hull
-- at it, have nobody else's armed hull there, and it was yours. Lorne
-- read the card and asked the obvious question — "I have not lowered
-- its HP, so why do I have an option to capture?" — which is the right
-- instinct about a thing this size. Nothing that costs twelve thousand
-- metal should change hands because a corvette drifted past it.
--
-- So a site is now something you have to BREAK before you can board it.
-- 200 points, uniform across kinds: a Mega Destroyer scaffold is no
-- tougher than a null field because neither is armoured — they are both
-- unfinished construction, and the thing that makes one harder to take
-- is the fleet its owner keeps parked on it.
--
-- Damage is permanent only while somebody is standing over it. Out of
-- contact the structure repairs itself, which is what stops a single
-- corvette grinding a site down over two hundred unattended ticks: to
-- take one you have to commit force and KEEP it there.
--
-- hp is on game_megastructures rather than game_bodies because it is a
-- property of the structure, not of the point in space it occupies —
-- and because game_bodies already carries destroyed_at_tick, which is
-- what a site at zero eventually becomes.
-- ============================================================

ALTER TABLE game_megastructures ADD COLUMN hp REAL NOT NULL DEFAULT 200;

-- Everything already standing starts intact. A site that was mid-build
-- when this shipped has not been shot at — it has simply never had the
-- column — so full health is the honest backfill rather than a guess
-- scaled to construction progress.
UPDATE game_megastructures SET hp = 200;

-- The seize check reads hp for every structure in a game on the tick a
-- player asks to take one, and the regen pass reads every damaged one
-- each tick. Both are game-scoped scans today; this keeps the damaged
-- set cheap to find as the count grows.
CREATE INDEX idx_mega_hp ON game_megastructures(game_id, hp);
