-- Safe: Batched backfill with batching comment and subquery LIMIT
-- batch-size: 1000
UPDATE users SET status = 'migrated' WHERE status = 'old' AND id IN (SELECT id FROM users WHERE status = 'old' LIMIT 1000);

-- ddlforge-ignore unbatched-dml
DELETE FROM logs WHERE created_at < NOW() - INTERVAL '30 days';
