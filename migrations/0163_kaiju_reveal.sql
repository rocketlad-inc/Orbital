-- ============================================================
-- 0163 — the Leviathan keeps its secret until it attacks
--
-- Lorne, 2026-10-08: "Keep the players wondering until it attacks."
-- Until its first wind-up over a world it is an unknown object: its hull
-- and its owner carry placeholder names, and every message calls it a
-- thing, never by name (worker/kaiju.js). The first wind-up is the
-- reveal; this is when it happened, NULL until then.
-- ============================================================

ALTER TABLE game_kaiju ADD COLUMN revealed_at_tick INTEGER;
