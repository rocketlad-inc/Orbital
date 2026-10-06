-- ============================================================
-- 0157 — the sun gates: the way in to the far systems
--
-- Somewhere between tick 250 and 300 every player is told that something
-- strange is emerging from the Sun. Six ticks later a gate leaves it,
-- burns out to the Far Reach and stops; forty ticks after that, the
-- second. Each is wired to a twin just past the outermost world of its
-- far system (worker/sunGates.js).
--
-- games.sun_gate_tick — the tick the omen is announced. NULL until the
--   first tick that looks at it, which rolls it from the game id. A game
--   already past its roll when this lands gets "twelve ticks from now"
--   instead (Lorne, 2026-10-06), and that is why it has to be stored:
--   "now" is only known once.
--
-- game_bodies.emerge_from_tick / emerge_until_tick — a body that does not
--   exist before emerge_from_tick (/state does not send it) and is still
--   in flight, outward from its parent along its final bearing, until
--   emerge_until_tick. NULL on both for every body that was simply there.
--
-- game_megastructures.transit_fraction — a gate crossing's share of the
--   ordinary burn. NULL is the warp gate's quarter; a sun gate is a tenth.
-- ============================================================

ALTER TABLE games ADD COLUMN sun_gate_tick INTEGER;
ALTER TABLE game_bodies ADD COLUMN emerge_from_tick INTEGER;
ALTER TABLE game_bodies ADD COLUMN emerge_until_tick INTEGER;
ALTER TABLE game_megastructures ADD COLUMN transit_fraction REAL;
