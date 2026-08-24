-- ============================================================
-- Structure hull points were calibrated against ships that do not exist.
--
-- 200 HP was chosen on the strength of "a destroyer needs about ten
-- ticks to break one". That arithmetic used the destroyer's BASE damage
-- of 22.5 — the number a hull has with no weapon mounts fitted, which is
-- to say a hull nobody ever flies.
--
-- A real destroyer carries six mounts. dmgBonus is
-- 0.40 x (1 + 0.10 x weaponsLvl) x mounts, so at Weapons 10 it fires for
-- 130.5, and even a middling three-mount build at Weapons 5 does 63.
-- Against those, 200 HP is under two ticks for one hull and a single
-- volley for a squadron. Every sentence written about the siege — the
-- pacing, the repair rate, the "commit force and keep it there" — was
-- describing a fight that could not happen.
--
-- 3000 puts it back where the design intended: a lone destroyer needs
-- twenty-odd ticks and must stay the whole time, three of them do it in
-- six to eight, and a corvette screen still cannot manage it at all
-- because repair now outruns their guns.
--
-- Existing structures scale rather than jump, so a site that was
-- half-broken stays half-broken.
-- ============================================================

UPDATE game_megastructures
   SET hp = MAX(1, ROUND(hp * 15.0))
 WHERE hp <= 200;

-- Anything already above the old ceiling (there should be none) is left
-- alone rather than inflated a second time by a re-run.
UPDATE game_megastructures SET hp = 3000 WHERE hp > 3000;
