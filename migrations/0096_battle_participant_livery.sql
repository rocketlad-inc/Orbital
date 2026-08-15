-- Battle participants: remember what the hull LOOKED like.
--
-- The recap draws the real ship sprite, which needs the icon variant the
-- player chose. That lives on game_ships, and a destroyed ship is gone
-- from game_ships — so a recap of the fight that killed it could only
-- ever fall back to the class default. Snapshot it with the rest of the
-- hull's identity, for the same reason hp_max and ship_name are
-- snapshotted: a recap must show the ship as it was.
--
-- `parts` already exists on this table (0092) but was never written.
-- The recording pass now fills it, which is what lets a recap tell an
-- energy lance from a kinetic tracer — the same read the map makes.

ALTER TABLE battle_participants ADD COLUMN icon_variant TEXT;
