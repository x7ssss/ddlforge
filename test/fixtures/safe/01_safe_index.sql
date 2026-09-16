-- Safe: CREATE INDEX CONCURRENTLY does not block table writes
CREATE INDEX CONCURRENTLY idx_users_email ON users(email);
CREATE UNIQUE INDEX CONCURRENTLY idx_users_username ON users(username);
