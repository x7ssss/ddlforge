-- HAZARDOUS: In PostgreSQL < 11 or with volatile defaults/locking,
-- adding NOT NULL with a DEFAULT causes an ACCESS EXCLUSIVE lock that blocks all traffic.
-- Even on PG 11+, acquiring ACCESS EXCLUSIVE locks queues behind concurrent reads,
-- causing a connection pool lock queue avalanche within seconds.
ALTER TABLE users ADD COLUMN is_verified BOOLEAN NOT NULL DEFAULT true;
