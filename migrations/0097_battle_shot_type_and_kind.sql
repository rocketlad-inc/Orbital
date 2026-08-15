-- What kind of shot it was, and what kind of thing fired or took it.
--
-- energy_share is the ATTACKER's energy fraction for that volley — the
-- exact number the damage roll used to blend weapon tech and to pick the
-- target's mitigation (shields cut kinetic, armor cuts energy). It is
-- recorded rather than re-derived because a recap of an old fight has to
-- show the loadout that fought it: the hull may have been refitted since,
-- or destroyed, and either way it can no longer answer the question.
--
-- kind separates a hull from a station from a city. Settlements were
-- always combatants — they get bombarded, an armed station shoots back,
-- and losing one is usually the point of the engagement — but only ships
-- were ever entered in the roster, so the shot log pointed at ids nothing
-- on the board owned.

ALTER TABLE battle_shots ADD COLUMN energy_share REAL NOT NULL DEFAULT 0;
ALTER TABLE battle_participants ADD COLUMN kind TEXT NOT NULL DEFAULT 'ship';
