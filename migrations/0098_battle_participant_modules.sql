-- What was built on a settlement that fought.
--
-- The station rig the map draws has weapons, shipyard, lab and thruster
-- modules, and a recap that cannot see their levels can only ever draw a
-- bare ring. Snapshotted like the rest of a combatant's identity, for the
-- same reason: the installation may be destroyed, and a recap has to show
-- what was there when it fought, not what is there now.
--
-- The other columns this migration's work fills were already declared in
-- 0092 and never written: captain_name, damage_absorbed and
-- killer_ship_id. The ledger has known all three all along -- the credited
-- killer HULL is the one the veterancy award already looks up, and
-- absorbed damage is the gap between damage_raw and damage that was being
-- recorded per shot and thrown away at read time.

ALTER TABLE battle_participants ADD COLUMN modules TEXT;
