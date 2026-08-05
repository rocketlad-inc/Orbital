-- 0063_combat_tally.sql
--
-- COMBAT V2 telemetry. Everything the balance simulations measured was
-- computed from shot-level data — volleys fired, volleys landed, damage
-- dealt, broken down by attacker class against target class. The live game
-- records none of that: analytics is derived from chronicle_entries and
-- game_ships, which only ever see the OUTCOME (a ship died) and never the
-- exchange that produced it.
--
-- Without this table there is no way to answer the question the rework
-- actually raises: does a corvette really hit a destroyer 88.9% of the time
-- in a real game, or did the model lie?
--
-- Shape is deliberately a rolling TALLY, not an event log. One row per
-- (game, attacker class, target class) — at most 6x6 = 36 rows per game,
-- UPSERTed once per tick. An event log would be millions of rows a day for
-- a number nobody reads per-shot.
--
--   volleys  shots taken (a miss still costs a volley)
--   hits     shots that landed
--   damage   total damage dealt AFTER mitigation, so it is what the target
--            actually absorbed rather than what was theoretically fired
--   kills    targets whose HP crossed zero on a tick this attacker class
--            damaged. Approximate by design: damage resolves simultaneously,
--            so with two classes shooting one hull both are credited. Read
--            it as "was present at the kill", not "landed the killing blow".
--
-- 'attacker_class' carries 'station' for settlement return fire, and
-- 'target_class' carries 'settlement' for bombardment, so the matrix covers
-- every combatant the game has rather than only ships.

CREATE TABLE IF NOT EXISTS game_combat_tally (
  game_id        TEXT NOT NULL,
  attacker_class TEXT NOT NULL,
  target_class   TEXT NOT NULL,
  volleys        INTEGER NOT NULL DEFAULT 0,
  hits           INTEGER NOT NULL DEFAULT 0,
  damage         REAL    NOT NULL DEFAULT 0,
  kills          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, attacker_class, target_class)
);

CREATE INDEX IF NOT EXISTS idx_combat_tally_game ON game_combat_tally(game_id);
