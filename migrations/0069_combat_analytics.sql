-- 0069_combat_analytics.sql
--
-- Second wave of combat telemetry. 0063 answered "does the hit matrix
-- hold up" with a per-matchup tally; this answers the questions that
-- came after it — are defensive parts worth their price, is output being
-- wasted on already-dead hulls, does repair outpace destruction, and WHO
-- actually won the battle.
--
-- Three additions:
--
-- 1. game_ship_stats — per-HULL lifetime combat record. The tally is
--    keyed by CLASS, which can never name a ship, so every MVP award
--    (Ace, Shipbreaker, Anvil, Untouchable, Executioner) and the loadout
--    analysis were impossible to compute. Bounded by ship count (low
--    hundreds per game), UPSERTed once per tick alongside the tally.
--
--    Rows survive the ship: a hull that died still won the award it
--    earned, and `alive` is resolved by joining game_ships at read time
--    rather than being denormalized here.
--
-- 2. damage_raw + overkill on game_combat_tally.
--      damage      = what the target actually absorbed (post-mitigation)
--      damage_raw  = what was fired at it (pre-mitigation)
--    The difference IS the value of shields and armor, which is the one
--    number that says whether the 1.75^k part pricing is right.
--      overkill    = damage landed on a hull that died the same tick,
--    beyond what was needed to kill it. Combat resolves simultaneously,
--    so this is real waste and the honest argument for/against focus
--    fire.
--
-- 3. game_combat_stats — small key/value counters per game, for totals
--    that aren't per-matchup or per-ship. Seeded with hp_repaired and
--    hp_destroyed so the repair economy can be read against the damage
--    economy (station repair just went from +2/tick to +5 per shipyard
--    level; this is how we would notice fleets becoming unkillable).
--    Key/value rather than columns so the next counter is a write, not a
--    migration.
--
-- All three are best-effort telemetry: worker/room.js wraps every write
-- in try/catch, and analytics.js tolerates the tables being absent, so an
-- un-migrated isolate degrades to the old panels instead of failing a
-- tick or a dashboard.

CREATE TABLE IF NOT EXISTS game_ship_stats (
  game_id        TEXT NOT NULL,
  ship_id        TEXT NOT NULL,
  -- Denormalized so a DEAD hull can still be named on the award board
  -- after its game_ships row is gone or recycled.
  ship_name      TEXT,
  ship_class     TEXT,
  faction_id     TEXT,
  shots          INTEGER NOT NULL DEFAULT 0,   -- volleys fired
  hits           INTEGER NOT NULL DEFAULT 0,   -- volleys that landed
  shots_taken    INTEGER NOT NULL DEFAULT 0,   -- volleys aimed at it
  hits_taken     INTEGER NOT NULL DEFAULT 0,   -- volleys that landed on it
  damage_dealt   REAL    NOT NULL DEFAULT 0,   -- post-mitigation
  damage_taken   REAL    NOT NULL DEFAULT 0,   -- post-mitigation
  damage_absorbed REAL   NOT NULL DEFAULT 0,   -- what its parts soaked
  kills          INTEGER NOT NULL DEFAULT 0,
  overkill       REAL    NOT NULL DEFAULT 0,   -- wasted on dead targets
  low_hp_kills   INTEGER NOT NULL DEFAULT 0,   -- kills landed under 25% HP
  PRIMARY KEY (game_id, ship_id)
);

CREATE INDEX IF NOT EXISTS idx_ship_stats_game ON game_ship_stats(game_id);

ALTER TABLE game_combat_tally ADD COLUMN damage_raw REAL NOT NULL DEFAULT 0;
ALTER TABLE game_combat_tally ADD COLUMN overkill REAL NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS game_combat_stats (
  game_id TEXT NOT NULL,
  stat    TEXT NOT NULL,
  value   REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, stat)
);
