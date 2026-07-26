-- Round-robin single-target combat: each combatant fires at ONE target
-- per volley (priority: armed ships → civilian ships → armed stations →
-- remaining settlements). The server records who each shooter is
-- currently engaging so the client's combat animation can aim its bolts
-- at the REAL target instead of a cosmetically-seeded guess.
ALTER TABLE game_ships ADD COLUMN last_target_id TEXT;
ALTER TABLE game_settlements ADD COLUMN last_target_id TEXT;
