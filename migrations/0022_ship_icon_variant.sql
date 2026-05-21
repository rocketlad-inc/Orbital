-- Ship icon variant — player's per-build pick from the 6 candidates
-- per class (A..F). Carried from build queue → spawned ship row so
-- the renderer can draw the icon the player chose at construction
-- time, not the class default.
--
-- icon_variant is a single character: 'A'..'F'. NULL means
-- "use the class default" — saves the row when older clients post
-- without the field. The client falls back to DEFAULT_SHIP_ICONS
-- at render time, so a missing column never breaks rendering.

ALTER TABLE game_body_build_queue ADD COLUMN icon_variant TEXT;
ALTER TABLE game_ships ADD COLUMN icon_variant TEXT;
