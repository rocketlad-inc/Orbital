-- The language a player chose (see worker/i18n.js). NULL = never chose:
-- the app follows the device, and emails go out in English.
ALTER TABLE users ADD COLUMN locale TEXT;
