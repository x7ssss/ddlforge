-- Dangerous: CONCURRENTLY inside explicit transaction block aborts
BEGIN;
CREATE INDEX CONCURRENTLY idx_posts_user ON posts(user_id);
COMMIT;
