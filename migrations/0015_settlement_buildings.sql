-- Settlement upgrade buildings (forge / mint / lab / weapons / shipyard).
--
-- The client has full UI for queueing per-settlement building upgrades
-- and a per-tick completion loop. The server was missing the schema +
-- endpoints entirely, so any MP build was wiped by the next /state poll
-- (same failure mode as the collector flag pre-0014).
--
-- Schema decision: JSON columns rather than join tables. Both blobs are
-- small (max 5 keys for buildings, single object for the order) and
-- they're always read together with the settlement row. A join table
-- would be cleaner but mean two extra queries per /state response.
--
--   buildings_json     {"forge": 2, "mint": 0, "lab": 1, ...}
--                      Missing key or 0 = not built.
--
--   building_order_json
--     {"kind": "forge", "target_level": 3,
--      "start_tick": 100, "complete_tick": 120}
--     NULL when nothing is in flight. One concurrent upgrade per
--     settlement — players have to spread their economy.

ALTER TABLE game_settlements ADD COLUMN buildings_json TEXT;
ALTER TABLE game_settlements ADD COLUMN building_order_json TEXT;
