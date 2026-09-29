-- Where each player found the game, stamped once when the account is
-- created (worker/attribution.js). NULL = signed up before this existed,
-- or from a client too old to send it; never guessed after the fact.
-- (Comments stay on their own lines: the runtime splitter only breaks
-- statements at a semicolon that ends a line.)

-- The label reports group by: link tag, utm source, 'invite', the
-- referring site, or 'direct'.
ALTER TABLE users ADD COLUMN signup_source TEXT;
-- utm_campaign, when a link carried one.
ALTER TABLE users ADD COLUMN signup_campaign TEXT;
-- The referring site, as a readable name ('reddit') or its host.
ALTER TABLE users ADD COLUMN signup_referrer TEXT;
-- The first page they landed on.
ALTER TABLE users ADD COLUMN signup_landing TEXT;
-- Their first visit, to see how long they took to sign up.
ALTER TABLE users ADD COLUMN signup_first_seen_ms INTEGER;
