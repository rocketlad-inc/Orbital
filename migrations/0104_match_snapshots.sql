-- Match snapshots: the whole game, reconstructable tick by tick.
--
-- One row per (game, tick). A KEYFRAME carries the complete world state;
-- a DELTA carries only the entities that changed since the previous tick
-- plus a removal list. Video encoding's trick, because the goal IS a
-- video: the entire match replayed at one second per tick.
--
-- Ships are stored as ORBITAL ELEMENTS, not positions. Elements change
-- only when a ship burns or transits, so they delta beautifully -- and
-- a player of the replay can derive a smooth position at any playback
-- instant instead of stepping between per-tick coordinates.
--
-- state is JSON: { v: 1, put: [...rows], del: [...keys] }
-- Every row is a compact array whose first element is its type:
--   's' ship:       [s, id, fid, cls, parent, rp, ra, omega, m0, epoch,
--                    dir, hp, status, icon_variant]
--   't' settlement: [t, id, body, fid, type, pop, hp]
--   'f' faction:    [f, id, metal, fuel, gold, science]
--   'p' pact:       [p, id, kind, ...signatory fids]
--   'r' route:      [r, id, fid, ship, origin, dest, status]
-- del lists prefixed keys ('s:<id>', 't:<id>', ...). A keyframe is the
-- same shape with every live entity in put and del empty. A reader
-- resets its world at a keyframe, then per delta upserts put rows by
-- key and drops del keys; a missing tick means nothing changed.
CREATE TABLE match_snapshots (
  game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  tick_number INTEGER NOT NULL,
  kind        TEXT NOT NULL,          -- 'key' | 'delta'
  state       TEXT NOT NULL,
  PRIMARY KEY (game_id, tick_number)
);

-- The replay reader's first question is "latest keyframe at or before
-- tick T"; give it an index that answers without scanning deltas.
CREATE INDEX idx_match_snapshots_key
  ON match_snapshots(game_id, kind, tick_number);
