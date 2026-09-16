-- Dangerous: Bare UPDATE and DELETE in migration without batching or limits
UPDATE users SET active = true;
DELETE FROM sessions;
