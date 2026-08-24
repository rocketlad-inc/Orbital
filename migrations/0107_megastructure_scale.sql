-- ============================================================
-- Megastructure sites were bigger than planets.
--
-- The catalogue gave them a radius of 7 to 12 when Venus is 3, Mercury
-- 2 and Luna 1.5 — larger than every world in the system bar Jupiter.
-- The renderer then multiplied by 1.4, and the art draws out to roughly
-- 1.6R beyond that, so a warp gate site rendered about three times the
-- width of the planet it was orbiting and read as the biggest object on
-- the board.
--
-- A station is not a world. New sites take the corrected radii from the
-- catalogue; this brings the ones already standing down to the same
-- numbers so existing games are fixed rather than left with a fleet of
-- oversized scaffolds.
--
-- Radius on a megastructure body is PURELY cosmetic — nothing derives
-- SOI, orbit or reach from it (soi is 0 by construction and structure
-- ranges live in the catalogue's effect block) — so this is safe to
-- change under a running game.
-- ============================================================

UPDATE game_bodies SET radius = 1.9
 WHERE type = 'megastructure' AND template_id = 'mega_warp_gate';
UPDATE game_bodies SET radius = 1.6
 WHERE type = 'megastructure' AND template_id = 'mega_weapons_station';
UPDATE game_bodies SET radius = 1.5
 WHERE type = 'megastructure' AND template_id = 'mega_gravity_sink';
UPDATE game_bodies SET radius = 1.5
 WHERE type = 'megastructure' AND template_id = 'mega_deep_array';
UPDATE game_bodies SET radius = 1.4
 WHERE type = 'megastructure' AND template_id = 'mega_null_field';
UPDATE game_bodies SET radius = 1.8
 WHERE type = 'megastructure' AND template_id = 'mega_mega_destroyer';
UPDATE game_bodies SET radius = 1.7
 WHERE type = 'megastructure' AND template_id = 'mega_mobile_foundry';

-- Anything typed megastructure that the per-kind rules above missed —
-- a template_id from an older build, say — still comes down to a
-- station-sized default rather than being left towering.
UPDATE game_bodies SET radius = 1.6
 WHERE type = 'megastructure' AND radius > 3;
