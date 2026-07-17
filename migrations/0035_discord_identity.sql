-- 0035_discord_identity.sql
--
-- Two-way Discord bot: identity linking + senate voting from Discord.
--
-- 1) users.discord_id / discord_username — a player links their Discord
--    account once (in-game "Link Discord" -> a short code -> /link <code>
--    in Discord). A button click in Discord then resolves
--    discord_id -> user -> that game's faction, so a vote lands with the
--    correct planet-count weight and one-vote-per-faction semantics.
--
-- 2) discord_link_codes — short-lived one-time codes minted in-game and
--    redeemed by the /link slash command. Rows are consumed on redeem and
--    expire on TTL; a cheap sweep in the redeem path clears stale ones.
--
-- 3) discord_senate_messages — maps a senate proposal to the Discord
--    message that carries its vote buttons, so the interactions handler
--    can edit that exact message to reflect the running tally (and a
--    future "voting closed" pass can disable its buttons).

ALTER TABLE users ADD COLUMN discord_id TEXT;
ALTER TABLE users ADD COLUMN discord_username TEXT;

-- One Discord account maps to at most one Orbital user. Partial unique
-- index so the many NULLs (unlinked users) don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_discord_id
  ON users(discord_id) WHERE discord_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS discord_link_codes (
  code        TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discord_link_codes_user ON discord_link_codes(user_id);

CREATE TABLE IF NOT EXISTS discord_senate_messages (
  proposal_id TEXT PRIMARY KEY,
  game_id     TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discord_senate_messages_game ON discord_senate_messages(game_id);
