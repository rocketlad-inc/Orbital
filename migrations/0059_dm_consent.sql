-- ============================================================================
-- 0059: explicit consent before the bot DMs anyone
--
-- 0057 shipped DMs as opt-OUT: an absent prefs row meant enabled, so the
-- moment a player linked Discord the bot could DM them. That is the wrong
-- default for a direct message. Linking exists to let you VOTE from
-- Discord and to put your name on senate cards; plenty of players want
-- exactly that and nothing in their inbox. Reading a link as permission
-- to DM is us deciding on their behalf.
--
-- So: a master gate, asked once at link time, above the per-category
-- prefs. The categories stay opt-out and answer "which of these DMs do I
-- want"; this answers the prior question, "do I want DMs at all".
--
--   NULL — never asked. No DMs. The bot asks at the next opportunity.
--   1    — yes, DM me.
--   0    — server only. Senate cards, the Herald and slash commands all
--          still work; nothing lands in their inbox.
--
-- Channel posts are deliberately NOT gated by this. They are addressed to
-- the room, not the person, and a player who declines DMs has said
-- nothing about the shared channel.
--
-- Existing linked accounts are grandfathered to 1 in the backfill below.
-- They linked under the old rule and have been receiving DMs without
-- complaint; silently cutting them off would be a second wrong default
-- rather than a fix for the first. Everyone who links from here on is
-- asked.
-- ============================================================================

ALTER TABLE users ADD COLUMN dm_consent INTEGER;
ALTER TABLE users ADD COLUMN dm_consent_ms INTEGER;

-- dm_consent_ms = 0 marks "grandfathered", never explicitly asked.
UPDATE users
   SET dm_consent = 1,
       dm_consent_ms = 0
 WHERE discord_id IS NOT NULL
   AND dm_consent IS NULL;
