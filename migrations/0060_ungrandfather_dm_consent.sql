-- ============================================================================
-- 0060: un-grandfather the accounts 0059 let through
--
-- 0059 backfilled every already-linked account to dm_consent = 1 on the
-- reasoning that they had been receiving DMs without complaint. That
-- reasoning was wrong in the way that matters: nobody had ever ASKED
-- them. They linked under a rule where linking silently switched DMs on,
-- so "didn't complain" is not consent — it's the absence of a question.
--
-- The point of the whole feature is that some players want the server
-- posts and nothing in their inbox. Grandfathering was the one case where
-- that preference still could not surface. Lorne's call, and the right
-- one.
--
-- Effect: every grandfathered account goes back to NULL — unasked, and
-- therefore no DMs — until they answer. The ask is already waiting for
-- them in two places they will hit naturally: the in-game Notifications
-- panel renders it whenever consent is NULL, and /notify poses it
-- instead of listing categories.
--
-- The cost, accepted deliberately: a player who touches neither surface
-- simply stops receiving DMs and is never told why. Senate cards, the
-- Herald and slash commands still reach them in the channel, so nobody
-- is cut off from the game itself — only from their inbox, which is
-- exactly the thing they never agreed to.
--
-- Targeted by dm_consent_ms = 0, the marker 0059 wrote for precisely
-- this: "grandfathered, never explicitly asked". Anyone who has answered
-- since carries a real timestamp and is left alone.
-- ============================================================================

UPDATE users
   SET dm_consent = NULL,
       dm_consent_ms = NULL
 WHERE dm_consent_ms = 0;
