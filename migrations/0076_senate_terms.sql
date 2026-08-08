-- 0076_senate_terms.sql
--
-- THE CHAIRMAN (Sean's proposal, via Lorne).
--
-- The senate's measured problem was never that bills lose debates. Of the
-- eleven bills ever proposed in production, FIVE drew zero votes, slider
-- laws went 0-for-6, and the one game that ended by Chancellor vote ended
-- on two votes out of seven eligible. Bills die of silence, and the
-- agenda was set by three players out of seven.
--
-- So the gavel rotates. One faction at a time holds the floor for a term;
-- only the chairman may put a bill up; one bill runs at a time. Everyone
-- gets the agenda eventually, and the senate gets a predictable "in
-- session" beat to notify against instead of bills appearing at random.
--
-- TERM LENGTH IS IN TICKS, not wall clock — live games run anywhere from
-- 30s to 1h per tick, and the same reasoning MIN_WINDOW_TICKS already
-- documents applies here. 24 ticks is the default Sean suggested; against
-- the 12-tick minimum bill (6 debate + 6 vote) that is exactly two bills
-- per term, which makes "as many as you can fit" a real budget: spend a
-- longer debate window on your first bill and you have spent your second.
--
-- ROTATION IS A SHUFFLED BAG, NOT A COIN FLIP. With 7 players, pure
-- random leaves a 34% chance somebody waits a whole rotation and 12% they
-- wait two. The bag keeps the order unpredictable while guaranteeing
-- everyone serves once before anyone serves twice. `bag_cycle` records
-- which pass through the bag a term belonged to, so the eligible set is
-- DERIVED from history rather than stored as mutable state — a faction
-- eliminated mid-cycle simply stops being eligible, and a late joiner
-- becomes eligible immediately, with no bookkeeping to drift out of sync.
--
-- There is deliberately NO forfeit rule (Lorne). A chairman who proposes
-- nothing burns their whole term. That is a known cost: four of seven
-- players in the completed game never proposed anything, so dead terms
-- will happen. Revisit if it bites.

CREATE TABLE senate_terms (
  id            TEXT PRIMARY KEY,
  game_id       TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  -- Chairman. No ON DELETE CASCADE: a term is history and should survive
  -- its holder, the same way senate_proposals keeps a plain reference.
  faction_id    TEXT NOT NULL,
  -- Monotonic per game, 0-based. Ordering key and display ("third term").
  term_index    INTEGER NOT NULL,
  -- Which pass through the bag. Everyone active serves once per cycle.
  bag_cycle     INTEGER NOT NULL,
  start_tick    INTEGER NOT NULL,
  -- EXCLUSIVE. The term covers [start_tick, end_tick).
  end_tick      INTEGER NOT NULL,
  -- Set when a term ends early — currently only 'eliminated' (the holder
  -- died mid-term and cannot legislate). NULL means it ran its length.
  ended_reason  TEXT,
  created_at_ms INTEGER NOT NULL
);

-- The hot query is "which term covers this tick in this game", run once
-- per senate resolution, i.e. every tick of every active game.
CREATE INDEX idx_senate_terms_current ON senate_terms(game_id, start_tick, end_tick);
-- Used by the bag draw to find who has already served this cycle.
CREATE INDEX idx_senate_terms_cycle ON senate_terms(game_id, bag_cycle);
