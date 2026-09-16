-- Safe: Transaction-scoped advisory locks auto-release on COMMIT/ROLLBACK
SELECT pg_advisory_xact_lock(12345);
SELECT pg_try_advisory_xact_lock(12345);
