-- One remix per person per map (security review, 2026-10-15): the
-- gallery's "remixed ×N" counted every remix call, so one player could
-- inflate a map's rank by remixing and deleting in a loop. A remix now
-- counts only the first time this player copies this map.
CREATE TABLE IF NOT EXISTS custom_map_remixes (
  map_id     TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  PRIMARY KEY (map_id, user_id)
);
