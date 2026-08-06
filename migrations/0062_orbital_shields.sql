-- ============================================================================
-- 0062: Orbital Shields — a regenerating second health bar for settlements
--
-- Ships have been able to bombard cities for a while and cities have had
-- exactly one answer: structure, which never comes back. A settlement that
-- lost a fight stayed lost, so the only real defence was a fleet parked on
-- top of it forever. Shields give a defender something that RECOVERS, which
-- turns a raid into a raid rather than an amputation.
--
-- The tech gate already existed — researchUnlocks.js has had
-- 'building.shields' (Armor 3, "Hardened Settlements") and the
-- BUILDING_FEATURE mapping pointing at it — with no building on the other
-- end. This is the other end.
--
-- Three columns rather than two:
--
--   shield_hp          current pool. Absorbs damage BEFORE structure.
--   shield_hp_max      derived from building level; stored so the tick
--                      does not have to parse buildings_json to clamp
--                      regen, and so the client gets it in /state for
--                      free.
--   shield_down_tick   when the pool last hit zero. Regen pauses for a
--                      grace period after a collapse, so a shield that
--                      just broke cannot immediately soak the next volley.
--                      NULL = never collapsed / already recovered.
--
-- Deliberately NOT backfilled to a positive value: existing settlements get
-- 0/0 and stay unshielded until someone builds the thing. Handing every
-- standing city a free shield would retroactively rewrite every siege
-- currently in progress, and there are cities under fire right now.
-- ============================================================================

ALTER TABLE game_settlements ADD COLUMN shield_hp REAL NOT NULL DEFAULT 0;
ALTER TABLE game_settlements ADD COLUMN shield_hp_max REAL NOT NULL DEFAULT 0;
ALTER TABLE game_settlements ADD COLUMN shield_down_tick INTEGER;
