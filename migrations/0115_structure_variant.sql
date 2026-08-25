-- ============================================================
-- Let the builder choose the silhouette.
--
-- Ships have had this since the icon expansion: nineteen variants per
-- class and a picker at construction. Megastructures had exactly one
-- look each, procedurally drawn, and every gate in every game was the
-- same gate.
--
-- Three per kind rather than nineteen. A structure is a landmark you
-- build a handful of, not a hull you stamp out by the dozen, and three
-- distinct silhouettes is the difference between "my gate" and "a gate"
-- without asking anyone to author sixty sprites.
--
-- NULL means "whoever built this chose nothing" and renders as A, so
-- every structure already standing keeps a valid look.
-- ============================================================

ALTER TABLE game_megastructures ADD COLUMN variant TEXT;
