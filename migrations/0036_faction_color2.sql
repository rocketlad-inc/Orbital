-- Two-tone faction colors (DESIGN-identity-economy.md §5).
-- PRIMARY (color) = ownership — all meaning stays here.
-- SECONDARY (color2) = decoration only (colorblind safety); legacy rows
-- get a derived secondary (lighten/darken of primary) at read time.
-- One ALTER per statement — D1 requirement.
ALTER TABLE game_factions ADD COLUMN color2 TEXT;
-- Lobby-side preference: players pick primary + secondary before start,
-- same pattern as empire_name / bio / chosen_starting_body (0005 / 0008).
ALTER TABLE room_members ADD COLUMN color TEXT;
ALTER TABLE room_members ADD COLUMN color2 TEXT;
