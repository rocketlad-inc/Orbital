-- 0156_game_feed_servers.sql
--
-- A game's Discord feed in the HOST'S OWN server (a Commission feature).
--
-- Until now every game's feed posted into one forum on the Orbital
-- server (0151). A host holding the Commander's Commission can now
-- connect their own server: one click through Discord's consent screen
-- adds the bot and picks the channel, and the game posts there instead.
-- The Commission is checked on every post (worker/gameFeed.js), so a
-- refunded one falls back to the Orbital forum on its own.
--
-- All nullable: no server_channel_id = the Orbital forum, as before.

ALTER TABLE game_feeds ADD COLUMN server_guild_id      TEXT;
ALTER TABLE game_feeds ADD COLUMN server_guild_name    TEXT;
ALTER TABLE game_feeds ADD COLUMN server_channel_id    TEXT;
ALTER TABLE game_feeds ADD COLUMN server_channel_name  TEXT;
-- 'forum' (one post per game, like the Orbital forum) or 'text' (the
-- game's posts land in the channel itself).
ALTER TABLE game_feeds ADD COLUMN server_channel_kind  TEXT;
-- The game's post in a server FORUM, made lazily like thread_id.
ALTER TABLE game_feeds ADD COLUMN server_thread_id     TEXT;
-- Whose Commission carries it. Checked on every post.
ALTER TABLE game_feeds ADD COLUMN server_by_user_id    TEXT;
ALTER TABLE game_feeds ADD COLUMN server_connected_ms  INTEGER;
