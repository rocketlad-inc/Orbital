-- ============================================================================
-- PEACE TAKES TWO. War took one.
--
-- The first cut let either side end a war with a single call, on the
-- reasoning that requiring both signatures would let a winner hold a
-- loser in a war they could not leave. That reasoning was wrong twice
-- over. Being held in a war you are losing is the POINT — it is what
-- gives peace a price and gives the winner something to negotiate for —
-- and a unilateral exit made the whole declaration free: declare, fire
-- everything, stand down before the reply lands, repeat, never once
-- being a legal target yourself.
--
-- So standing down is now an OFFER. One side proposes, the war runs on,
-- and it ends the moment the other side answers in kind. Either side can
-- withdraw an offer it has not had answered.
--
-- No expiry on an offer, deliberately. An offer left standing is a
-- standing willingness to stop, which is a true thing to advertise, and
-- expiring it would only mean re-sending the same message on a timer.
-- ============================================================================

-- Who has offered, and when. NULL = no offer on the table. The offer is
-- one-sided by construction: the moment the OTHER side offers, the war
-- ends and this column stops being read.
ALTER TABLE game_wars ADD COLUMN ceasefire_by TEXT REFERENCES game_factions(id);
ALTER TABLE game_wars ADD COLUMN ceasefire_at_tick INTEGER;
