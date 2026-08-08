-- 0075_backfill_faction_emblems.sql
--
-- Give every EXISTING faction a real emblem.
--
-- 0074 added the column and left legacy rows NULL, on the reasoning that
-- resolveEmblem() draws a deterministic fallback for those. That reasoning
-- was wrong on the point that matters: the fallback hashes the faction id
-- into 24 shapes INDEPENDENTLY per faction, with nothing coordinating the
-- results. Eight factions drawing from 24 shapes collide about three times
-- in four (1 - 24!/(16!·24^8) ≈ 0.76) — so in a live 8-player game two
-- empires flying the same emblem was the LIKELY outcome, not the edge case.
-- An emblem that isn't unique is worse than no emblem: it actively tells
-- you two different players are the same one.
--
-- The fix is the assignment a fresh seed would have produced. With no
-- lobby picks to honour (nothing wrote room_members.emblem before 0074),
-- defaultEmblemFor(slot, []) reduces to EMBLEM_IDS[slot] — so this is a
-- straight slot→id map, and a game seeded today and a game backfilled
-- here end up identical.
--
-- KEEP IN SYNC with EMBLEM_IDS in worker/emblems.js and
-- src/game/emblems.ts. Order matters here: this hardcodes the catalog's
-- index order, which is exactly why those files say ids are permanent.
--
-- Only slots 0-23 are covered. max_players caps at 8, so a higher slot
-- means something unusual happened; those keep NULL and fall through to
-- the render-time fallback rather than being wrapped into a collision.

UPDATE game_factions
   SET emblem = CASE slot
     WHEN  0 THEN 'star'     WHEN  1 THEN 'sun'      WHEN  2 THEN 'moon'
     WHEN  3 THEN 'comet'    WHEN  4 THEN 'orbit'    WHEN  5 THEN 'ring'
     WHEN  6 THEN 'crown'    WHEN  7 THEN 'shield'   WHEN  8 THEN 'spear'
     WHEN  9 THEN 'trident'  WHEN 10 THEN 'hammer'   WHEN 11 THEN 'anchor'
     WHEN 12 THEN 'skull'    WHEN 13 THEN 'wolf'     WHEN 14 THEN 'phoenix'
     WHEN 15 THEN 'eye'      WHEN 16 THEN 'key'      WHEN 17 THEN 'gear'
     WHEN 18 THEN 'helix'    WHEN 19 THEN 'leaf'     WHEN 20 THEN 'wave'
     WHEN 21 THEN 'mountain' WHEN 22 THEN 'tower'    WHEN 23 THEN 'pyramid'
   END
 WHERE emblem IS NULL
   AND slot BETWEEN 0 AND 23;
