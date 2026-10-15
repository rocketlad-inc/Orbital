-- ============================================================
-- 0166 - grandfathered ship looks
--
-- On 2026-10-15 the free ship looks narrowed from A-I to A and B on
-- every hull (A and B hold every class's default). C-Z come with the
-- Commander's Commission. A player who had ALREADY built with a look
-- that became paid keeps it, for that hull class: one row per
-- (player, class, look) found at cutover in their ships (every game,
-- every status, destroyed ones too), in-game designs, build queue and
-- account templates.
--
-- Only C-I are granted: J-Z were always Commission looks, so nobody
-- could have built with them without it.
--
-- worker/store.js validateIconVariant reads this. Rerunnable: the
-- inserts are OR IGNORE, so a second pass only adds what is new.
-- ============================================================

CREATE TABLE IF NOT EXISTS user_look_grants (
  user_id     TEXT    NOT NULL,
  ship_class  TEXT    NOT NULL,
  variant     TEXT    NOT NULL,
  granted_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, ship_class, variant)
);

INSERT OR IGNORE INTO user_look_grants (user_id, ship_class, variant, granted_at)
SELECT DISTINCT f.user_id, s.ship_class, s.icon_variant, CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM game_ships s JOIN game_factions f ON f.id = s.owner_faction_id
 WHERE f.user_id IS NOT NULL AND s.icon_variant IN ('C', 'D', 'E', 'F', 'G', 'H', 'I');

INSERT OR IGNORE INTO user_look_grants (user_id, ship_class, variant, granted_at)
SELECT DISTINCT f.user_id, d.ship_class, d.icon_variant, CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM game_ship_designs d JOIN game_factions f ON f.id = d.faction_id
 WHERE f.user_id IS NOT NULL AND d.icon_variant IN ('C', 'D', 'E', 'F', 'G', 'H', 'I');

INSERT OR IGNORE INTO user_look_grants (user_id, ship_class, variant, granted_at)
SELECT DISTINCT f.user_id, q.ship_class, q.icon_variant, CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM game_body_build_queue q JOIN game_factions f ON f.id = q.faction_id
 WHERE f.user_id IS NOT NULL AND q.icon_variant IN ('C', 'D', 'E', 'F', 'G', 'H', 'I');

INSERT OR IGNORE INTO user_look_grants (user_id, ship_class, variant, granted_at)
SELECT DISTINCT t.user_id, t.ship_class, t.icon_variant, CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM user_ship_templates t
 WHERE t.user_id IS NOT NULL AND t.icon_variant IN ('C', 'D', 'E', 'F', 'G', 'H', 'I');
