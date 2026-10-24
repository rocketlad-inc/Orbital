-- Computer empire personalities (worker/aiPersona.js, Lorne 2026-10-24).
--   ai_personality        'ally' | 'warlord' | 'snake'
--   ai_personality_shown  1 when the player picked it at setup (the roster
--                         shows it); 0 for "Surprise me" (shown when the
--                         game ends)
--   ai_state              its memory, JSON: grudges, peace times, the
--                         Snake's phase
ALTER TABLE game_factions ADD COLUMN ai_personality TEXT;
ALTER TABLE game_factions ADD COLUMN ai_personality_shown INTEGER NOT NULL DEFAULT 0;
ALTER TABLE game_factions ADD COLUMN ai_state TEXT;
