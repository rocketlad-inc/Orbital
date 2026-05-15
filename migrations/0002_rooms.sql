-- Rooms: a lobby record for each game session. The live state lives in a Durable Object
-- keyed by room.id; this table is the index for discovery / cross-user queries.
CREATE TABLE rooms (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  host_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'lobby',  -- 'lobby' | 'in_progress' | 'closed'
  max_players INTEGER NOT NULL DEFAULT 4,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_rooms_status ON rooms(status, updated_at DESC);

-- Memberships: who has joined which room. The DO is the source of truth for who's
-- currently connected; this table records the intent ("I have a seat in this room").
CREATE TABLE room_members (
  room_id   TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, user_id)
);

CREATE INDEX idx_members_user ON room_members(user_id);
