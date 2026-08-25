-- ============================================================
-- Megastructures outlive the factions that built them.
--
-- Elimination fires when a faction has no live settlements. It never
-- touched their structures, so a dead player's Weapons Station went on
-- shooting, their Gravity Sink went on grabbing and their Null Field
-- went on blinding — forever, fighting a war on behalf of somebody who
-- had already lost, and with no way to sign peace with a corpse.
--
-- ABANDONED is the answer: the structure stays standing and stops
-- belonging to anyone, and the first faction to put a ship in its orbit
-- can claim it.
--
-- Ownership goes to NULL, which does most of the work for free because
-- every effect pass already asks "who owns this" before firing:
--   - the Weapons Station falls silent (no owner, no enemies)
--   - the Deep Space Array goes dark (vision is granted to the owner
--     and their allies; there are none)
--   - the Null Field keeps blinding, and the Gravity Sink keeps
--     grabbing, because neither needs a commander to be dangerous
-- which is the right read: a derelict is quiet where it needs a crew
-- and hazardous where it does not.
--
-- abandoned_at_tick is what separates it from an ANCIENT gate, which is
-- also unowned and must stay unclaimable — one faction holding the map's
-- only permanent crossing would be a different game. Ancients have no
-- founder and no abandonment date; an abandoned structure has both.
-- ============================================================

ALTER TABLE game_megastructures ADD COLUMN abandoned_at_tick INTEGER;

CREATE INDEX idx_mega_abandoned ON game_megastructures(game_id, abandoned_at_tick);
