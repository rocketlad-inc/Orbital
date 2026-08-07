-- 0068_captain_only_veterancy.sql
--
-- Veterancy is CAPTAIN-ONLY from here (Lorne: "I don't want hulls to
-- carry veterancy anymore. Captains only. If a hull makes a kill with no
-- captain, it gets no credit").
--
-- Until now a kill by an uncrewed hull wrote game_ships.rank /
-- combat_history, and every read used COALESCE(c.rank, s.rank). COALESCE
-- only falls through on NULL, and a fresh captain's rank is 0 — so
-- boarding an officer SHADOWED the hull's record rather than replacing
-- it. Six live hulls were sitting on hidden veterancy, the worst a
-- destroyer with 6 kills reading as rank 0 (−6% damage, −6% HP, no kill
-- list) from the moment its captain arrived.
--
-- The reads now take the captain's rank or zero, so these columns are
-- unread. Zeroing them anyway is the point of the migration: leaving
-- live-looking data behind a changed rule is how the NEXT query that
-- forgets the rule resurrects it. game_captains is untouched — that is
-- where every real record now lives.
--
-- Live at time of writing: 46 active hulls with rank > 0, of which 7
-- carry a captain. Their kill HISTORY is discarded with the rank; those
-- kills stay in the chronicle, which is the permanent record of what
-- happened. Nobody's damage bonus drops, because a shadowed rank was
-- already contributing nothing.
--
-- IDEMPOTENT: re-running matches zero rows once the columns are zero.

UPDATE game_ships
   SET rank = 0,
       combat_history = NULL
 WHERE COALESCE(rank, 0) <> 0
    OR combat_history IS NOT NULL;
