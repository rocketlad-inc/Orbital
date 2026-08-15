-- Battle records — the full account of a single engagement.
--
-- The game already kept two combat aggregates: game_combat_tally (per
-- attacker-class x target-class, game-wide) and game_ship_stats (per hull,
-- lifetime). Both are totals. Neither can answer "what happened at Mars",
-- because both throw away WHEN and WHERE a shot was fired the moment it is
-- counted, and neither knows that a run of violent ticks at one body is one
-- event a player would call a battle.
--
-- A BATTLE is a body plus a contiguous run of combat ticks. It opens on the
-- first shot at that body and closes after QUIET_TICKS consecutive ticks with
-- no shot there, so a fleet that trades fire, drifts, and re-engages two ticks
-- later stays one battle rather than fragmenting into three.
--
-- Four tables, in descending grain:
--   battles              one row per engagement, with rollups
--   battle_participants  one row per hull that was present
--   battle_ticks         one row per battle-tick — the playback frames
--   battle_shots         one row per shot — the finest grain we keep

CREATE TABLE IF NOT EXISTS battles (
  id                TEXT PRIMARY KEY,
  game_id           TEXT NOT NULL,
  body_id           TEXT,
  body_name         TEXT,
  -- The tick of the first shot and of the last shot. ended_tick stays NULL
  -- while the battle is live; closed_tick records when the quiet window
  -- actually elapsed, which is later than the last shot by design.
  started_tick      INTEGER NOT NULL,
  last_fire_tick    INTEGER NOT NULL,
  ended_tick        INTEGER,
  closed_at_ms      INTEGER,
  started_at_ms     INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'ended'

  -- Rollups, maintained as the battle runs so the list view needs no joins.
  tick_count        INTEGER NOT NULL DEFAULT 0,
  shots             INTEGER NOT NULL DEFAULT 0,
  hits              INTEGER NOT NULL DEFAULT 0,
  damage            REAL    NOT NULL DEFAULT 0,
  damage_raw        REAL    NOT NULL DEFAULT 0,
  ships_lost        INTEGER NOT NULL DEFAULT 0,
  settlements_lost  INTEGER NOT NULL DEFAULT 0,
  faction_count     INTEGER NOT NULL DEFAULT 0,

  -- Who was in it, as a JSON array of faction ids, and the alliance graph AS
  -- IT STOOD when the battle opened. Treaties signed after the shooting
  -- starts do not rewrite the history of the fight they interrupted, and a
  -- pact torn up mid-battle is exactly the thing worth being able to see.
  faction_ids       TEXT,
  peace_pairs_open  TEXT,
  -- Recomputed at close, so a betrayal shows as a difference.
  peace_pairs_close TEXT,
  -- Decided at close: the faction with hulls still standing and kills to its
  -- name. NULL when nobody can be said to have won.
  victor_faction_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_battles_game    ON battles(game_id, started_tick DESC);
CREATE INDEX IF NOT EXISTS idx_battles_active  ON battles(game_id, status, body_id);

CREATE TABLE IF NOT EXISTS battle_participants (
  battle_id       TEXT NOT NULL,
  ship_id         TEXT NOT NULL,
  faction_id      TEXT,
  ship_name       TEXT,
  ship_class      TEXT,
  -- Snapshotted so a recap can show the hull as it was, not as the design
  -- reads after a later refit.
  hp_max          REAL,
  hp_start        REAL,
  hp_end          REAL,
  parts           TEXT,
  captain_name    TEXT,
  rank            INTEGER NOT NULL DEFAULT 0,

  first_tick      INTEGER NOT NULL,
  last_tick       INTEGER NOT NULL,
  died_tick       INTEGER,
  killer_ship_id  TEXT,
  killer_faction_id TEXT,

  shots           INTEGER NOT NULL DEFAULT 0,
  hits            INTEGER NOT NULL DEFAULT 0,
  shots_taken     INTEGER NOT NULL DEFAULT 0,
  hits_taken      INTEGER NOT NULL DEFAULT 0,
  damage_dealt    REAL    NOT NULL DEFAULT 0,
  damage_taken    REAL    NOT NULL DEFAULT 0,
  damage_absorbed REAL    NOT NULL DEFAULT 0,
  kills           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (battle_id, ship_id)
);
CREATE INDEX IF NOT EXISTS idx_bparts_battle ON battle_participants(battle_id);

-- One frame per tick. The recap animates BETWEEN these, so a frame has to
-- carry enough to draw the whole board: every hull present with its hp, and
-- every shot fired that tick. Stored as JSON rather than joined at read time
-- because playback wants whole frames in order and nothing else.
CREATE TABLE IF NOT EXISTS battle_ticks (
  battle_id     TEXT NOT NULL,
  tick_number   INTEGER NOT NULL,
  seq           INTEGER NOT NULL,          -- 0-based frame index
  shots         INTEGER NOT NULL DEFAULT 0,
  hits          INTEGER NOT NULL DEFAULT 0,
  damage        REAL    NOT NULL DEFAULT 0,
  kills         INTEGER NOT NULL DEFAULT 0,
  -- [{ id, fid, cls, name, hp, hpMax, dead }]
  roster        TEXT,
  -- [{ a, t, hit, dmg, kill }] — attacker/target ship ids
  shot_log      TEXT,
  PRIMARY KEY (battle_id, tick_number)
);
CREATE INDEX IF NOT EXISTS idx_bticks_battle ON battle_ticks(battle_id, seq);

CREATE TABLE IF NOT EXISTS battle_shots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  battle_id       TEXT NOT NULL,
  tick_number     INTEGER NOT NULL,
  attacker_ship_id  TEXT,
  attacker_faction_id TEXT,
  attacker_class  TEXT,
  target_ship_id  TEXT,
  target_faction_id TEXT,
  target_class    TEXT,
  hit             INTEGER NOT NULL DEFAULT 0,
  damage          REAL    NOT NULL DEFAULT 0,
  damage_raw      REAL    NOT NULL DEFAULT 0,
  killed          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_bshots_battle ON battle_shots(battle_id, tick_number);
