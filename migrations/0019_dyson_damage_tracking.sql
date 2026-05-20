-- ============================================================================
-- Orbital — Dyson Sphere damage-delta tracking
-- ============================================================================
--
-- Phase B shipped the sphere with collapse-on-foundation-destruction as the
-- only server-side loss vector. To let combat damage actually contest a
-- sphere in MP, the server tick processor needs to know how much HP the
-- foundation station lost since the last tick. We track that as a single
-- "last seen" column on the games row: each tick, tickDysonSphere reads
-- the foundation's current HP, compares to last_seen, applies the delta
-- to the sphere proportionally, then writes current HP back into the
-- column for next tick. NULL means "not initialized yet" — first read
-- after foundation-laying seeds it without applying damage.
-- ============================================================================

ALTER TABLE games ADD COLUMN dyson_station_last_hp INTEGER;
