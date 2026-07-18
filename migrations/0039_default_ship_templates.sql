-- Seed a "Default" ship template per class for every EXISTING user.
-- New signups get theirs in handleSignup (worker/index.js); this covers
-- everyone who already had an account.
--
-- Ids are deterministic ('tpl_def_<user>_<class>') and each INSERT is
-- guarded by NOT EXISTS, so re-running is a no-op — important because
-- the migration runner may retry a partially-applied migration.
--
-- Loadouts KEEP IN SYNC with DEFAULT_LOADOUTS in worker/shipDesigns.js.
-- A user who edits or deletes their Default keeps that choice: the guard
-- only skips on (user, class, name='Default'), and a deleted one is not
-- resurrected because this migration runs exactly once.

INSERT INTO user_ship_templates (id, user_id, name, ship_class, parts_json, icon_variant, created_at_ms)
SELECT 'tpl_def_' || u.id || '_corvette', u.id, 'Default', 'corvette',
       '["weapon","engine"]', NULL, 0
  FROM users u
 WHERE NOT EXISTS (
   SELECT 1 FROM user_ship_templates t
    WHERE t.user_id = u.id AND t.ship_class = 'corvette' AND t.name = 'Default'
 );

INSERT INTO user_ship_templates (id, user_id, name, ship_class, parts_json, icon_variant, created_at_ms)
SELECT 'tpl_def_' || u.id || '_frigate', u.id, 'Default', 'frigate',
       '["weapon","weapon","shield","engine"]', NULL, 0
  FROM users u
 WHERE NOT EXISTS (
   SELECT 1 FROM user_ship_templates t
    WHERE t.user_id = u.id AND t.ship_class = 'frigate' AND t.name = 'Default'
 );

INSERT INTO user_ship_templates (id, user_id, name, ship_class, parts_json, icon_variant, created_at_ms)
SELECT 'tpl_def_' || u.id || '_destroyer', u.id, 'Default', 'destroyer',
       '["weapon","weapon","weapon","shield","shield","engine"]', NULL, 0
  FROM users u
 WHERE NOT EXISTS (
   SELECT 1 FROM user_ship_templates t
    WHERE t.user_id = u.id AND t.ship_class = 'destroyer' AND t.name = 'Default'
 );

INSERT INTO user_ship_templates (id, user_id, name, ship_class, parts_json, icon_variant, created_at_ms)
SELECT 'tpl_def_' || u.id || '_freighter', u.id, 'Default', 'freighter',
       '["engine"]', NULL, 0
  FROM users u
 WHERE NOT EXISTS (
   SELECT 1 FROM user_ship_templates t
    WHERE t.user_id = u.id AND t.ship_class = 'freighter' AND t.name = 'Default'
 );
