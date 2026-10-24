-- ============================================================
-- 0181 — Solo games: one player against computer empires (worker/solo.js).
--
-- Single player came back as a SOLO MULTIPLAYER ROOM (Lorne, 2026-10-23):
-- the same server, the same rules, the human seated beside 1-5 computer
-- empires that act through the real game actions (worker/aiEmpire.js).
--
-- games.solo        1 = a solo game: kept out of Browse, Quick Join, the
--                   Herald and every other place that assumes people.
-- games.paused      1 = time stands still (no ticks, no alarm) until the
--                   solo player resumes. Only solo games pause.
-- games.solo_difficulty  'peaceful' | 'normal' | 'ruthless'.
-- game_factions.ai_doctrine   the computer empire's strategy ('rusher',
--                   'expander', 'economist', 'technocrat'); NULL = a person.
-- game_factions.ai_last_tick  the last tick it took a turn on, so the
--                   cron acts once per new tick at most.
--
-- Schema only, constant defaults: safe to re-run, and every existing game
-- reads as not solo, not paused, all human.
-- ============================================================

ALTER TABLE games ADD COLUMN solo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE games ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE games ADD COLUMN solo_difficulty TEXT;
ALTER TABLE game_factions ADD COLUMN ai_doctrine TEXT;
ALTER TABLE game_factions ADD COLUMN ai_last_tick INTEGER;
