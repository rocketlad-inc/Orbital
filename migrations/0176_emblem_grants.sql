-- ============================================================
-- 0176 - earned emblems (Oct 19 insight report, Invites idea 5)
--
-- An emblem can now be EARNED, not bought. The first is 'recruiter',
-- granted when a friend you invited (users.referred_by, 0175) takes a
-- seat in a game that has started. It rewards bringing players, not
-- paying. worker/invites.js grants it; worker/lobby.js refuses an earned
-- emblem to anyone without the grant.
-- ============================================================

CREATE TABLE IF NOT EXISTS user_emblem_grants (
  user_id     TEXT    NOT NULL,
  emblem      TEXT    NOT NULL,
  granted_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, emblem)
);
