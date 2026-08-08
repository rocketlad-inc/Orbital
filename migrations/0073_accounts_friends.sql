-- 0073_accounts_friends.sql
--
-- Account upgrade (Lorne): rename yourself, friend other players, and
-- see your own career.
--
-- 1. RENAME. display_name already exists and is what every surface
--    shows; it just had no way to change after signup. The only new
--    state is when it last changed, so the endpoint can rate-limit and
--    the UI can say "you can rename again in N days" instead of failing
--    silently. Deliberately NOT unique: identity is the user id (and
--    email), display names are labels, and forcing global uniqueness on
--    a live table with existing duplicates would mean rejecting names
--    people already have.
--
-- 2. FRIENDS. One row per PAIR, not per direction. Two-row designs make
--    "are these two friends" a question you can get half-right, and the
--    half-right answer is the bug: A sees B as a friend while B doesn't.
--    The pair is keyed on (user_lo, user_hi) with the ids sorted, so a
--    pair can only exist once no matter who asked.
--
--      status       'pending' until accepted, then 'accepted'
--      requested_by who sent it — the OTHER party is the one who may
--                   accept, which is what stops self-accepting
--
--    A decline DELETEs the row rather than storing 'declined': keeping
--    a tombstone would let a declined request block a later genuine one,
--    and silently. Blocking is deliberately not modelled yet; it wants
--    its own semantics (hide from search, prevent invite) rather than
--    being smuggled in as a third status.
--
-- 3. CAREER. No new tables. Everything worth showing is already
--    recorded — game_factions says which games you played,
--    games.winner_faction_id says who won, chronicle_entries has builds
--    and losses, and game_ship_stats (0069) has kills. Aggregating on
--    read keeps one source of truth; these are per-profile-view queries,
--    not per-tick, so the cost is irrelevant.

ALTER TABLE users ADD COLUMN display_name_changed_ms INTEGER;

CREATE TABLE IF NOT EXISTS user_friends (
  user_lo      TEXT NOT NULL,
  user_hi      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  requested_by TEXT NOT NULL,
  created_ms   INTEGER NOT NULL,
  updated_ms   INTEGER NOT NULL,
  PRIMARY KEY (user_lo, user_hi)
);

CREATE INDEX IF NOT EXISTS idx_friends_lo ON user_friends(user_lo, status);
CREATE INDEX IF NOT EXISTS idx_friends_hi ON user_friends(user_hi, status);
