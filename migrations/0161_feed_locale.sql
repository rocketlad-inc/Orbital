-- 0161: the language a game's Discord feed is written in (worker/gameFeed.js).
--
-- A feed is ONE thread everybody reads, so its language is the game's, not
-- each reader's: the host picks it in the game's feed settings. NULL = the
-- host did not pick, and the feed follows the host's own language
-- (users.locale, 0160), else English. Values are the locales worker/i18n.js
-- supports ('en', 'pt-BR').
ALTER TABLE game_feeds ADD COLUMN feed_locale TEXT;
