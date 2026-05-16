-- Add a level counter to faction_techs so the server can track infinite
-- Stellaris-style repeatables. The original schema only carried a
-- 'researching' / 'completed' status with no notion of how many times the
-- tech had been advanced. The level column reaches >0 once the first
-- buy-up has happened; status flips between researching/completed for the
-- current-in-progress tier (unused for instant-research v1, kept for the
-- future progress-bar model).

ALTER TABLE faction_techs ADD COLUMN level INTEGER NOT NULL DEFAULT 0;
