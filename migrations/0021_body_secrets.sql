-- Body secrets — hidden surprises seeded onto non-capital bodies at
-- game start. Match the client-side BodySecret model in src/types.ts +
-- src/game/secrets.ts. Server-side authoritative: server picks the
-- placements deterministically from map_seed at seedGameWorld time
-- (factions.js), and the reveal handler fires inside resolveTick
-- (room.js) the first tick a ship reaches a body with an unrevealed
-- secret.
--
-- Hidden from /state until revealed; clients must not see secret_kind
-- on bodies their ships haven't visited (see worker/state.js).
--
-- Kinds (one of BodySecretKind in client types):
--   portal_to_sun     persistent warp-to-Sol effect on arrival
--   ancient_city      discoverer gets a free city + Lab L2
--   free_collector    discoverer gets a free city with has_collector=1
--   derelict_warship  discoverer gets a free destroyer at the body
--   resource_cache    discoverer's pool gets +500 metal + 500 gold
--   ancient_databank  discoverer gets a +1 level in a random tech track
--
-- All new columns default to NULL/0 so existing bodies backfill clean.

ALTER TABLE game_bodies ADD COLUMN secret_kind TEXT;
ALTER TABLE game_bodies ADD COLUMN secret_revealed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE game_bodies ADD COLUMN secret_discovered_by_faction_id TEXT;
ALTER TABLE game_bodies ADD COLUMN secret_discovered_at_tick INTEGER;
