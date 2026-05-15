-- Per-member chosen starting body. References a template id from the
-- worker's BODY_CATALOG (e.g. 'inara', 'verda', 'rust'). Null means
-- auto-assign at game start (the legacy behavior).
ALTER TABLE room_members ADD COLUMN chosen_starting_body TEXT;
