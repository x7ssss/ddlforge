-- Safe: Column renamed explicitly without dropping data
ALTER TABLE users RENAME COLUMN legacy_name TO current_name;
