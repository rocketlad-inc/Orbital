-- Combat state on each ship row. Damage and HP mirror the client's
-- src/game/shipClasses.ts so server resolution stays balanced with
-- the player's intuition. damage_per_tick is the auto-fire rate at
-- a body shared with a hostile faction. status already exists; we
-- repurpose 'destroyed' (was reserved) once hp falls to zero.

ALTER TABLE game_ships ADD COLUMN hp REAL NOT NULL DEFAULT 100;
ALTER TABLE game_ships ADD COLUMN hp_max REAL NOT NULL DEFAULT 100;
ALTER TABLE game_ships ADD COLUMN damage_per_tick REAL NOT NULL DEFAULT 0;
