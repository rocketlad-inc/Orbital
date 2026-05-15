-- Add invite codes and optional passwords to rooms.
-- invite_code: short URL-safe random string for "join by code" flow.
-- password_hash: NULL = open room; otherwise pbkdf2$... matches the
--   same format as users.password_hash (verifyPassword in worker/auth.js).

ALTER TABLE rooms ADD COLUMN invite_code TEXT;
ALTER TABLE rooms ADD COLUMN password_hash TEXT;

CREATE UNIQUE INDEX idx_rooms_invite_code ON rooms(invite_code) WHERE invite_code IS NOT NULL;
