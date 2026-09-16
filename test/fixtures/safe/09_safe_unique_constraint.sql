-- Safe: Two-phase UNIQUE via concurrent index + USING INDEX
CREATE UNIQUE INDEX CONCURRENTLY idx_users_email_unique ON users (email);
ALTER TABLE users ADD CONSTRAINT users_email_unique UNIQUE USING INDEX idx_users_email_unique;
