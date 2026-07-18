-- Cross-game ship templates.
--
-- game_ship_designs is scoped to a single game, so every new match
-- started with an empty design library and players rebuilt the same
-- loadouts from scratch. These are USER-scoped: saved once, loadable
-- into any game's designer, and they follow the account across devices
-- (which is why this is a server table rather than localStorage).
--
-- Deliberately NOT a foreign key to game_ship_designs: a template is a
-- detached snapshot. Deleting the design (or the whole game) it was
-- saved from must never delete the template.
CREATE TABLE IF NOT EXISTS user_ship_templates (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  ship_class    TEXT NOT NULL,
  parts_json    TEXT,
  icon_variant  TEXT,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_ship_templates_user
  ON user_ship_templates (user_id, ship_class, created_at_ms);
