-- ============================================================
-- 0144 — the situation log's ROWS, beside its count (0137).
--
-- The watch's Situation page drew only battles and inbound fleets and
-- read "NO CONTACT" while the game's own log listed votes, offers, idle
-- yards and arrivals: only the badge count ever reached the server. The
-- log is derived in the browser from the whole game state plus that
-- browser's dismissals, so -- as with the count -- the open game reports
-- what it shows, and the watch mirrors it, exact but as old as the last
-- time the game was open.
--
-- JSON [{tier, sev, title, sub?, body?}], at most 20, validated and
-- trimmed by the handler (worker/analytics.js handleSituationBadge).
-- ============================================================

ALTER TABLE situation_badges ADD COLUMN items TEXT;
