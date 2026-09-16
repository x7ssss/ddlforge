-- Unsafe: Session-level advisory locks leak across pooler connections
SELECT pg_advisory_lock(12345);
SELECT pg_try_advisory_lock(12345);
