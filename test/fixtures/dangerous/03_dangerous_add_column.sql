-- Dangerous: Adding NOT NULL column without DEFAULT fails on non-empty table
ALTER TABLE users ADD COLUMN role VARCHAR(50) NOT NULL;
