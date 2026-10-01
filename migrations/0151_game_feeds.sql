-- 0151: per-game Discord feeds (worker/gameFeed.js).
--
-- Every game used to post to ONE shared channel, switched on by a single
-- Discord-linked player. Each game now has its own post in a forum
-- channel, and the HOST turns it on (Lorne, 2026-10-01).
--
-- Keyed by room id (games.id === rooms.id), so the host can set it in the
-- lobby before the game row exists.

CREATE TABLE IF NOT EXISTS game_feeds (
  game_id          TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  -- 'off' | 'headlines' | 'all'. Off unless the host says otherwise.
  level            TEXT NOT NULL DEFAULT 'off',
  -- The game's forum post, made lazily on its first post.
  thread_id        TEXT,
  guild_id         TEXT,
  -- Fast-game wall-clock cap: the current window, posts in it, and how
  -- many were held back (summarised once when the window turns over).
  window_start_ms  INTEGER NOT NULL DEFAULT 0,
  window_posts     INTEGER NOT NULL DEFAULT 0,
  suppressed       INTEGER NOT NULL DEFAULT 0,
  updated_ms       INTEGER NOT NULL DEFAULT 0
);

-- Players who asked to follow from inside the game. Discord's own thread
-- membership is what notifies them; this is how the bot knows whom to
-- add when the thread is first made, and what the toggle shows.
CREATE TABLE IF NOT EXISTS game_feed_followers (
  game_id     TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_ms  INTEGER NOT NULL,
  PRIMARY KEY (game_id, user_id)
);
