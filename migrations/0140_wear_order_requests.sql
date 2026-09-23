-- A watch asking to be allowed to give orders.
--
-- THE OLD WAY ONLY WORKED ON A COLD START. The watch handed the phone a
-- URL and the grant happened in a script in the page shell, so if the
-- game was ALREADY open the launch just brought it forward, no document
-- loaded, no question was asked, and the watch sat polling for a token
-- nobody had minted. That is the "it opens the app but nothing happens"
-- players reported.
--
-- Now the watch files a REQUEST against its own token, and the game asks
-- the question wherever it is running -- including the next time it is
-- opened, which is the case a launch URL can never cover.
--
-- One row per ask. `code` is the pairing code the watch will collect the
-- new token with (widget_pairings), so an allowed request lands in the
-- machinery that already exists rather than a second one beside it.
CREATE TABLE IF NOT EXISTS wear_order_requests (
  code        TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_ms  INTEGER NOT NULL,
  -- null while it waits; 'allowed' or 'denied' once answered.
  decision    TEXT,
  decided_ms  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_wear_order_requests_pending
  ON wear_order_requests(user_id, created_ms)
  WHERE decision IS NULL;
