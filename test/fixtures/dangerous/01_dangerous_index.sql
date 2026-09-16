-- Dangerous: CREATE INDEX without CONCURRENTLY locks the table for writes
CREATE INDEX idx_users_email ON users(email);
CREATE UNIQUE INDEX idx_users_ssn ON users(ssn);
