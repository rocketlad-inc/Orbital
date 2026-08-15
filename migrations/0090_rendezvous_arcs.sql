-- ============================================================
-- 0090 — rendezvous arcs (DESIGN-transit-combat.md, the missing order §2/§3)
--
-- Migration 0088 stores a flip-and-burn: one launch state, one
-- acceleration, one flip. That describes every transfer in the game
-- because every transfer aims at a body, and a body sits still relative
-- to the arrival.
--
-- Meeting a SHIP is a different manoeuvre. You have to match its
-- velocity as well as its position, and the shape that does it is
-- burn / coast / burn — two arcs in unrelated directions, not one
-- flip. flip_tick cannot express that, so the two burns are stored as
-- Δv VECTORS and their durations fall out of the engine (t = |Δv|/accel).
--
-- WHAT HAPPENS AFTER THE MEETING is the other half, and it needs no
-- geometry at all: at rv_meet_tick the two hulls are at the same place
-- with the same velocity, so the follower simply IS the followed ship
-- from then on. Store who to follow and evaluate their plan. That is
-- what holds the formation for the rest of the flight rather than
-- letting it drift apart one tick after it forms.
--
-- All nullable and additive: a node with rv_ax NULL is an ordinary
-- flip-and-burn and behaves exactly as it did before this shipped.
-- ============================================================

-- First burn, as a Δv vector. Duration = |A| / accel.
ALTER TABLE game_ship_nodes ADD COLUMN rv_ax REAL;
ALTER TABLE game_ship_nodes ADD COLUMN rv_ay REAL;

-- Second burn — the one that kills the remaining relative velocity so
-- the two hulls end up matched rather than merely co-located.
ALTER TABLE game_ship_nodes ADD COLUMN rv_bx REAL;
ALTER TABLE game_ship_nodes ADD COLUMN rv_by REAL;

-- When the match happens. Before this the ship flies its own two arcs;
-- after it, it flies the followed ship's plan.
ALTER TABLE game_ship_nodes ADD COLUMN rv_meet_tick REAL;

-- The hull being joined. Deliberately NOT a foreign key: the target can
-- be destroyed mid-approach, and the correct behaviour then is for the
-- follower to hold its matched state and coast to the same destination,
-- not for the row to vanish.
ALTER TABLE game_ship_nodes ADD COLUMN rv_follow_ship_id TEXT;
