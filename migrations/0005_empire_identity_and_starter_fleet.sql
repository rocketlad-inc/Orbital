-- Pre-game empire identity (set in lobby, carried into the game).
-- empire_name overrides the rotating-default faction name; bio is freeform
-- player-authored flavor text shown in the faction roster / diplomacy UI.
ALTER TABLE room_members ADD COLUMN empire_name TEXT;
ALTER TABLE room_members ADD COLUMN bio TEXT;

-- Bio carried through to the in-game faction record so it survives
-- after the lobby row could in principle be cleared.
ALTER TABLE game_factions ADD COLUMN bio TEXT;
