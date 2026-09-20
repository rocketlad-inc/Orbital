-- 0135_widget_pairings.sql
--
-- HOW A WIDGET GETS ITS TOKEN WITHOUT ANYONE PRESSING ANYTHING.
--
-- The widget is native code; the login lives in Chrome. Two ways of
-- crossing that boundary were tried and both are unreliable on a real
-- phone:
--
--   * A custom-scheme redirect (orbital://widget?token=...) from the
--     connect page. Chrome refuses to launch an external app from a
--     navigation that had no user gesture, and a page-load redirect has
--     none. It fails silently.
--   * Reading the session cookie on the connect page itself. The cookie
--     is SameSite=Strict, and a navigation launched from an app intent
--     is cross-site as far as Chrome is concerned, so the page arrives
--     signed out even though the game inside the same tab is signed in.
--
-- So this is device pairing, the way a TV signs in. The native side
-- invents a random code and opens the connect page with it. The page --
-- whose own fetch() calls DO carry the Strict cookie, being same-site
-- subresource requests -- binds that code to a freshly minted token.
-- The native side polls for the code and collects the token. No gesture,
-- no scheme hop, no cookie on a navigation.
--
-- A pairing is one-shot and short-lived: claimed_ms is set on the first
-- successful claim, and anything older than ten minutes is dead whether
-- claimed or not. The code is the only secret and it never leaves the
-- device except in the URL the device itself opened.

CREATE TABLE IF NOT EXISTS widget_pairings (
  code        TEXT PRIMARY KEY,
  token       TEXT NOT NULL REFERENCES widget_tokens(token) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  created_ms  INTEGER NOT NULL,
  claimed_ms  INTEGER
);
