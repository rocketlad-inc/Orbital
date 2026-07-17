-- 0033_align_ship_hp_with_client.sql
--
-- Server/client HP table mismatch — playtester report (Lorne, 2026-06-26):
-- newly built frigates were spawning at 80/100 HP and freighters at 30/60
-- in the UI even with zero combat in the session. Root cause: the server
-- HP tables in worker/factions.js and worker/room.js were
--   frigate: 80, freighter: 30
-- but the client shipClasses.ts says
--   frigate: 100, freighter: 60
-- The HP bar renders `ship.hp / clientDef.hp`, so the cap mismatch was
-- visible from frame one.
--
-- This migration:
--   1. Heals any ship currently AT its old cap (= 80 frigate, = 30 freighter)
--      up to the new cap. Ships at LESS than the old cap have real combat
--      damage — they keep it. The hp_max bump (step 2) raises the ceiling
--      they can later repair to.
--   2. Bumps hp_max to the new value for every frigate / freighter still
--      sitting at the old hp_max. Future spawns will use the new table
--      (worker code is being updated in the same change).
--
-- Idempotent: re-running is a no-op once hp_max has been bumped, because
-- the WHERE clauses gate on the old values.

UPDATE game_ships
   SET hp = 100
 WHERE ship_class = 'frigate'
   AND hp = 80
   AND hp_max = 80;

UPDATE game_ships
   SET hp = 60
 WHERE ship_class = 'freighter'
   AND hp = 30
   AND hp_max = 30;

UPDATE game_ships
   SET hp_max = 100
 WHERE ship_class = 'frigate'
   AND hp_max = 80;

UPDATE game_ships
   SET hp_max = 60
 WHERE ship_class = 'freighter'
   AND hp_max = 30;
